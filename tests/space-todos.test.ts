import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { createClient } from '@libsql/client';
import type { GitHost, ModelCatalog, ModelInfo } from '../src/core/ports.ts';
import { quotedFrom } from '../src/core/briefs.ts';
import { todoStartMessage } from '../src/core/space-todos.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-space-todos-'));
process.env.ANTON_DATA_DIR = path.join(dir, 'data');
after(() => rmSync(dir, { recursive: true, force: true }));

const fakeHost = {
	name: 'fake',
	getRepo: async (fullName: string) => ({ fullName, defaultBranch: 'main', private: false }),
	listBranches: async () => ['main'],
	resolveRef: async () => 'sha-main',
	tree: async () => ['README.md'],
	file: async () => new TextEncoder().encode('# demo\n'),
	cloneUrl: () => '',
	gitAuthEnv: () => ({}),
	accountName: async () => 'Ada Lovelace',
	listRepos: async () => ['acme/api', 'acme/web'],
	searchRepos: async () => [],
	searchFiles: async () => [],
} as unknown as GitHost;

const model = (id: string, vision = false): ModelInfo => ({
	id,
	name: id,
	vendor: 'Test',
	description: '',
	createdAt: 0,
	contextLength: 128_000,
	maxOutput: null,
	price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	vision,
	reasoning: ['low', 'high'],
	defaultReasoning: 'high',
});
const fakeCatalog: ModelCatalog = {
	name: 'fake',
	list: async () => [model('openrouter/test/cheap', false), model('openrouter/test/strong', true)],
};

const { useDatabase } = await import('../src/db/client.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { addProject } = await import('../src/services/projects/projects.ts');
const { setAgentDelivery } = await import('../src/services/tasks/agent-runner.ts');
const { recordAgentEvent } = await import('../src/services/tasks/activity.ts');
const spaces = await import('../src/services/projects/spaces.ts');
const todos = await import('../src/services/projects/todos.ts');
const { stateBlock } = await import('../src/services/projects/coordinator.ts');
const sessions = await import('../src/services/tasks/sessions.ts');
const { spaceRoutes } = await import('../src/routes/spaces.ts');
const { attachToProject } = await import('../src/services/artifacts/attachments.ts');
const { splitAttachments } = await import('../src/core/attachments.ts');
const { removeSpaceFile } = await import('../src/services/projects/space-files.ts');

useDatabase(createClient({ url: `file:${path.join(dir, 'anton.db')}` }));
setProviders({ sandbox: localSandboxProvider(path.join(dir, 'data')), store: diskStore(path.join(dir, 'data', 'objects')), git: fakeHost, models: fakeCatalog });

const toThreads: Array<{ id: string; text: string }> = [];
const toCoordinator: Array<{ id: string; text: string; images?: Array<{ filename?: string; mimeType: string }> }> = [];
let failCoordinator = false;

setAgentDelivery(async (id, text) => {
	toThreads.push({ id, text });
	recordAgentEvent({ type: 'submission_running', instanceId: id, submissionId: `sub-${toThreads.length}` });
	recordAgentEvent({ type: 'submission_settled', instanceId: id, submissionId: `sub-${toThreads.length}` });
});
setAgentDelivery(async (id, text, images) => {
	if (failCoordinator) throw new Error('coordinator unreachable');
	// Thread reports go out on a timer a second after a thread starts, so one can land in a later test; none is checked here.
	if (text.startsWith('<thread-reports>')) return;
	toCoordinator.push({ id, text, images });
}, 'coordinator');

beforeEach(() => {
	toThreads.length = 0;
	toCoordinator.length = 0;
	failCoordinator = false;
});

const apiRepo = await addProject('acme/api');

test('to-dos are added, edited, marked done or open again, and deleted', async () => {
	const space = await spaces.createSpace({ name: 'Todo CRUD', repoIds: [apiRepo.id] });
	await assert.rejects(() => todos.createTodo(space.id, { title: '   ' }), /title/);
	const item = await todos.createTodo(space.id, { title: '  Fix the OAuth redirect ', description: 'Back to the page asked for.' });
	assert.deepEqual([item.title, item.status, item.assignee, item.createdBy], ['Fix the OAuth redirect', 'open', null, 'user']);

	const done = await todos.editTodo(space.id, item.id, { status: 'done', title: 'Fix OAuth redirect' });
	assert.equal(done.status, 'done');
	assert.ok(done.completedAt);
	const reopened = await todos.editTodo(space.id, item.id, { status: 'open' });
	assert.deepEqual([reopened.title, reopened.status, reopened.completedAt], ['Fix OAuth redirect', 'open', null]);

	await todos.removeTodo(space.id, item.id);
	assert.deepEqual(await todos.listTodos(space.id), []);
});

test('a to-do started as a thread follows it: in progress while it works, done once it resolves, open again if it is deleted', async () => {
	const space = await spaces.createSpace({ name: 'Todo thread', repoIds: [apiRepo.id] });
	const item = await todos.createTodo(space.id, { title: 'Add rate limits', description: 'Limit /login to 5 a minute.' });
	const { todo, thread } = await todos.startTodo(space.id, item.id, 'thread');
	assert.ok(thread);
	assert.equal(thread.title, 'Add rate limits');
	assert.deepEqual([todo.status, todo.assignee, todo.threads], ['in_progress', 'thread', 1]);
	await assert.rejects(() => todos.startTodo(space.id, item.id, 'thread'), /already started/);

	await sessions.editSession(thread.id, { resolved: true });
	const [done] = await todos.listTodos(space.id);
	assert.equal(done.status, 'done');
	assert.ok(done.completedAt);
	await sessions.editSession(thread.id, { resolved: false });
	assert.equal((await todos.listTodos(space.id))[0].status, 'done', 'done stays done');

	const other = await todos.createTodo(space.id, { title: 'Second' });
	const started = await todos.startTodo(space.id, other.id, 'thread');
	await sessions.deleteSession(started.thread!.id);
	const back = (await todos.listTodos(space.id)).find((entry) => entry.id === other.id)!;
	assert.deepEqual([back.status, back.assignee], ['open', null], 'its only thread deleted, it waits again');
});

test('a to-do handed to the coordinator is sent as the user’s words, links the threads it starts, and is done when they all resolve', async () => {
	const space = await spaces.createSpace({ name: 'Todo coordinator', repoIds: [apiRepo.id], autonomy: 'propose' });
	const item = await todos.createTodo(space.id, { title: 'Migrate billing webhooks', description: 'Use the new signing secret.' });

	failCoordinator = true;
	await assert.rejects(() => todos.startTodo(space.id, item.id, 'coordinator'), /unreachable/);
	assert.equal((await todos.listTodos(space.id))[0].status, 'open', 'a failed hand-over leaves it open');
	failCoordinator = false;

	const { todo } = await todos.startTodo(space.id, item.id, 'coordinator');
	assert.deepEqual([todo.status, todo.assignee, todo.threads], ['in_progress', 'coordinator', 0]);
	assert.equal(toCoordinator.length, 1);
	assert.equal(toCoordinator[0].text, todoStartMessage(item));
	assert.ok(quotedFrom('Migrate billing webhooks … Use the new signing secret.', toCoordinator[0].text), 'the start_thread quote check passes on it');
	assert.equal((await todos.listTodos(space.id))[0].status, 'in_progress', 'with no thread yet it stays with the coordinator');
	assert.match(await stateBlock(space.id), /\[todo:\w{8}\] "Migrate billing webhooks" · started, no thread yet/);

	const t1 = await spaces.startThread(space.id, { title: 'Parser', brief: 'Update the parser' });
	const t2 = await spaces.startThread(space.id, { title: 'Tests', brief: 'Add tests' });
	const ref = (await stateBlock(space.id)).match(/\[todo:(\w{8})\]/)![1];
	await todos.linkTodoToThread(space.id, (await todos.findTodo(space.id, ref)).id, t1.id);
	const linked = await todos.linkTodoToThread(space.id, item.id, t2.id);
	assert.deepEqual([linked.assignee, linked.threads], ['coordinator', 2]);

	await sessions.editSession(t1.id, { resolved: true });
	assert.equal((await todos.listTodos(space.id))[0].status, 'in_progress', 'one thread still open');
	await sessions.editSession(t2.id, { resolved: true });
	assert.equal((await todos.listTodos(space.id))[0].status, 'done');
	assert.doesNotMatch(await stateBlock(space.id), /Migrate billing webhooks/, 'done to-dos leave the project state');
});

test('the to-do routes validate their input', async () => {
	const space = await spaces.createSpace({ name: 'Todo routes', repoIds: [apiRepo.id] });
	const call = (method: string, url: string, body?: unknown) =>
		spaceRoutes.request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
	const created = await call('POST', `/api/spaces/${space.id}/todos`, { title: 'Write docs' });
	assert.equal(created.status, 200);
	const { id } = (await created.json()) as { id: string };
	// Rejected before anything changes (the app turns these into a 400).
	for (const [method, url, body] of [
		['POST', `/api/spaces/${space.id}/todos`, { title: '' }],
		['PATCH', `/api/spaces/${space.id}/todos/${id}`, { status: 'in_progress' }],
		['POST', `/api/spaces/${space.id}/todos/${id}/start`, { target: 'elsewhere' }],
	] as const)
		assert.notEqual((await call(method, url, body)).status, 200);
	assert.equal((await todos.listTodos(space.id))[0].status, 'open');
	assert.equal((await call('POST', `/api/spaces/${space.id}/todos/${id}/start`, { target: 'coordinator' })).status, 200);
	assert.equal((await call('DELETE', `/api/spaces/${space.id}/todos/${id}`)).status, 200);
	assert.equal(((await (await call('GET', `/api/spaces/${space.id}/todos`)).json()) as { todos: unknown[] }).todos.length, 0);
});

test("a to-do's screenshots and files are kept in the project's Library and go with the brief it starts, images as pictures", async () => {
	const space = await spaces.createSpace({ name: 'Todo files', repoIds: [apiRepo.id] });
	await spaces.editSpace(space.id, { coordinatorModel: 'openrouter/test/strong' });
	const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
	const shot = await attachToProject(space.id, 'broken-button.png', png, 'image/png');
	const log = await attachToProject(space.id, 'console.txt', new TextEncoder().encode('TypeError: export is not a function'), 'text/plain');
	const ref = ({ name, path, kind, size }: typeof shot) => ({ name, path, kind, size });

	await assert.rejects(() => todos.createTodo(space.id, { title: 'Nope', attachments: [{ name: 'x.png', path: 'not-uploaded.png', kind: 'PNG image', size: 1 }] }), /not in the project's files/);
	const item = await todos.createTodo(space.id, { title: 'Fix the export button', description: 'It does nothing on Safari.', attachments: [ref(shot), ref(log), ref(shot)] });
	assert.deepEqual(
		item.attachments.map((file) => [file.path, file.size]),
		[
			['broken-button.png', png.length],
			['console.txt', 35],
		],
		'each once, at the size the Library has',
	);
	assert.match(await stateBlock(space.id), /"Fix the export button" · open · files: broken-button\.png, console\.txt/);

	const { thread } = await todos.startTodo(space.id, item.id, 'thread');
	// The brief reaches the thread behind the answer.
	for (let tries = 0; tries < 100 && !toThreads.some((sent) => sent.id === thread!.id); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
	const brief = toThreads.find((sent) => sent.id === thread!.id)!.text;
	const sent = splitAttachments(brief);
	assert.equal(sent.text, 'Fix the export button\n\nIt does nothing on Safari.');
	assert.deepEqual(
		sent.files.map((file) => [file.path, file.place]),
		[
			['broken-button.png', 'project'],
			['console.txt', 'project'],
		],
	);
	assert.match(brief, /TypeError: export is not a function/, "a text file's words go with it");

	// One deleted from the Library since is left out; the coordinator, whose model sees, gets the screenshot as a picture.
	const second = await todos.createTodo(space.id, { title: 'Restyle the toolbar', attachments: [ref(shot), ref(log)] });
	await removeSpaceFile(space.id, 'console.txt');
	await todos.startTodo(space.id, second.id, 'coordinator');
	assert.equal(toCoordinator.length, 1);
	assert.ok(toCoordinator[0].text.startsWith(todoStartMessage(second)));
	assert.deepEqual(
		splitAttachments(toCoordinator[0].text).files.map((file) => file.path),
		['broken-button.png'],
	);
	assert.deepEqual(
		toCoordinator[0].images?.map((image) => [image.filename, image.mimeType]),
		[['broken-button.png', 'image/png']],
	);

	const edited = await todos.editTodo(space.id, second.id, { attachments: [] });
	assert.deepEqual(edited.attachments, []);
});
