import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { createClient } from '@libsql/client';
import type { GitHost, ModelCatalog, ModelInfo } from '../src/core/ports.ts';
import { parseTodoAssign, TODO_NO_REPO, todoAssignMessage, todoBrief } from '../src/core/space-todos.ts';

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

const model = (id: string): ModelInfo => ({
	id,
	name: id,
	vendor: 'Test',
	description: '',
	createdAt: 0,
	contextLength: 128_000,
	maxOutput: null,
	price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	vision: false,
	reasoning: ['low', 'high'],
	defaultReasoning: 'high',
});
const fakeCatalog: ModelCatalog = { name: 'fake', list: async () => [model('openrouter/test/cheap'), model('openrouter/test/strong')] };

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

useDatabase(createClient({ url: `file:${path.join(dir, 'anton.db')}` }));
setProviders({ sandbox: localSandboxProvider(path.join(dir, 'data')), store: diskStore(path.join(dir, 'data', 'objects')), git: fakeHost, models: fakeCatalog });

const toThreads: Array<{ id: string; text: string }> = [];
const toCoordinator: Array<{ id: string; text: string }> = [];

setAgentDelivery(async (id, text) => {
	toThreads.push({ id, text });
	const submissionId = `sub-${toThreads.length}`;
	recordAgentEvent({ type: 'submission_running', instanceId: id, submissionId });
	recordAgentEvent({ type: 'submission_settled', instanceId: id, submissionId });
});
setAgentDelivery(async (id, text) => void toCoordinator.push({ id, text }), 'coordinator');

beforeEach(() => {
	toThreads.length = 0;
	toCoordinator.length = 0;
});

const apiRepo = await addProject('acme/api');
const webRepo = await addProject('acme/web');

test('todo CRUD, validation, metadata normalization, and reordering', async () => {
	const space = await spaces.createSpace({ name: 'Todo CRUD', repoIds: [apiRepo.id, webRepo.id] });

	await assert.rejects(() => todos.createTodo(space.id, { title: '   ' }), /title/);
	await assert.rejects(() => todos.createTodo(space.id, { title: 'Bad URL', sourceUrl: 'javascript:alert(1)' }), /http/);
	await assert.rejects(() => todos.createTodo(space.id, { title: 'Bad date', dueAt: 'not-a-date' }), /valid date/);
	await assert.rejects(() => todos.createTodo(space.id, { title: 'Bad repo', projectId: 'proj_missing' }), /repository/);

	const first = await todos.createTodo(space.id, {
		title: 'Fix OAuth redirect',
		description: 'Redirect back to the requested route after login.',
		priority: 'high',
		tags: ['auth', 'Auth', '  bug  '],
		repo: 'api',
		model: 'openrouter/test/strong',
		reasoning: 'high',
		planMode: true,
		dueAt: '2026-12-01',
		sourceUrl: 'https://github.com/acme/api/issues/42',
	});
	assert.equal(first.status, 'open');
	assert.equal(first.assigneeKind, 'unassigned');
	assert.equal(first.projectId, apiRepo.id);
	assert.deepEqual(first.tags, ['auth', 'bug']);
	assert.equal(first.planMode, true);
	assert.equal(first.dueAt, '2026-12-01');

	const second = await todos.createTodo(space.id, {
		title: 'Research pricing page',
		projectId: TODO_NO_REPO,
		priority: 'low',
	});
	assert.equal(second.projectId, TODO_NO_REPO);

	const reordered = await todos.reorderTodos(space.id, [second.id, first.id]);
	assert.deepEqual(
		reordered.map((item) => item.id),
		[second.id, first.id],
	);

	const edited = await todos.editTodo(space.id, first.id, { status: 'done', priority: 'urgent' });
	assert.equal(edited.status, 'done');
	assert.equal(edited.priority, 'urgent');
	assert.ok(edited.completedAt);

	const reopened = await todos.editTodo(space.id, first.id, { status: 'open' });
	assert.equal(reopened.status, 'open');
	assert.equal(reopened.completedAt, null);

	await todos.removeTodo(space.id, second.id);
	assert.deepEqual(
		(await todos.listTodos(space.id)).map((item) => item.id),
		[first.id],
	);
});

test('assigning a todo to the coordinator removes it from open todos immediately and sends <todo-assign>', async () => {
	const space = await spaces.createSpace({ name: 'Coord Assign', repoIds: [apiRepo.id], autonomy: 'propose' });
	const item = await todos.createTodo(space.id, {
		title: 'Migrate billing webhooks',
		description: 'Move Stripe webhook verification to the new signing secret.',
		priority: 'urgent',
		tags: ['billing'],
		projectId: apiRepo.id,
	});

	const { todo: assigned } = await todos.assignTodo(space.id, item.id, { target: 'coordinator', note: 'Ship before Friday' });
	assert.equal(assigned.status, 'triaging');
	assert.equal(assigned.assigneeKind, 'coordinator');
	assert.ok(assigned.assignedAt);

	const coordMsgs = toCoordinator.filter((msg) => msg.id === space.id);
	assert.equal(coordMsgs.length, 1);
	const parsed = parseTodoAssign(coordMsgs[0].text);
	assert.ok(parsed);
	assert.equal(parsed.id, item.id);
	assert.equal(parsed.title, 'Migrate billing webhooks');
	assert.equal(parsed.priority, 'urgent');
	assert.equal(parsed.repo, 'acme/api');
	assert.deepEqual(parsed.tags, ['billing']);
	assert.match(parsed.body, /Stripe webhook verification/);
	assert.match(parsed.body, /Ship before Friday/);

	const state = await stateBlock(space.id);
	assert.match(state, /To-dos \(1 open\/assigned\)/);
	assert.match(state, /Migrate billing webhooks/);
	assert.match(state, /assigned to coordinator/);

	// Coordinator converts the todo into two threads; resolving both auto-completes the todo, reopening either reopens it.
	const t1 = await spaces.startThread(space.id, { title: 'Webhook parser', brief: 'Update parser' });
	const t2 = await spaces.startThread(space.id, { title: 'Webhook tests', brief: 'Add webhook tests' });
	await todos.linkTodoToThread(space.id, item.id, t1.id);
	const linked = await todos.linkTodoToThread(space.id, item.id, t2.id);
	assert.equal(linked.status, 'in_progress');
	assert.deepEqual(linked.threadIds, [t1.id, t2.id]);

	await sessions.editSession(t1.id, { resolved: true });
	let current = (await todos.listTodos(space.id))[0];
	assert.equal(current.status, 'in_progress', 'still in progress while second thread is open');

	await sessions.editSession(t2.id, { resolved: true });
	current = (await todos.listTodos(space.id))[0];
	assert.equal(current.status, 'done', 'auto-completes once every linked thread resolves');
	assert.ok(current.completedAt);

	await sessions.editSession(t2.id, { resolved: false });
	current = (await todos.listTodos(space.id))[0];
	assert.equal(current.status, 'in_progress', 'reopens when a linked thread reopens');
	assert.equal(current.completedAt, null);
});

test('assigning a todo directly to a new or existing thread, and cleanup on thread/space deletion', async () => {
	const space = await spaces.createSpace({ name: 'Direct Thread', repoIds: [apiRepo.id, webRepo.id] });
	const one = await todos.createTodo(space.id, {
		title: 'Add health check endpoint',
		description: 'Return 200 OK with git SHA on /healthz.',
		projectId: webRepo.id,
		planMode: true,
	});
	const two = await todos.createTodo(space.id, {
		title: 'Add readiness check',
		description: 'Check DB connectivity too.',
	});

	const started = await todos.assignTodo(space.id, one.id, { target: 'new-thread' });
	assert.equal(started.todo.status, 'in_progress');
	assert.equal(started.todo.assigneeKind, 'thread');
	assert.ok(started.thread);
	assert.equal(started.thread.repo, 'acme/web');
	assert.equal(started.thread.planMode, true);
	assert.deepEqual(started.todo.threadIds, [started.thread.id]);
	for (let tries = 0; toThreads.length === 0 && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.match(toThreads[0].text, /Add health check endpoint/);
	assert.match(toThreads[0].text, /Return 200 OK/);

	const nudged = await todos.assignTodo(space.id, two.id, { target: 'thread', threadId: started.thread.id });
	assert.equal(nudged.todo.status, 'in_progress');
	assert.deepEqual(nudged.todo.threadIds, [started.thread.id]);
	assert.match(toThreads.at(-1)!.text, /Add readiness check/);

	// Deleting the thread unlinks both in-progress todos and returns them to open so work is not lost.
	await spaces.deleteTask(started.thread.id);
	const afterDelete = await todos.listTodos(space.id);
	for (const item of afterDelete) {
		assert.equal(item.status, 'open');
		assert.equal(item.assigneeKind, 'unassigned');
		assert.deepEqual(item.threadIds, []);
	}

	// Archived project rejects assignment.
	await spaces.editSpace(space.id, { state: 'archived' });
	await assert.rejects(() => todos.assignTodo(space.id, one.id, { target: 'coordinator' }), /archived/);

	// Deleting the space removes its todos cleanly.
	await spaces.removeSpace(space.id);
	await assert.rejects(() => todos.listTodos(space.id), /Project not found/);
});

test('todoBrief and todoAssignMessage formatting helpers', () => {
	assert.equal(todoBrief({ title: 'Title only', description: '', sourceUrl: null }), 'Title only');
	assert.equal(
		todoBrief({ title: 'Fix bug', description: 'Details here', sourceUrl: 'https://example.com/1' }),
		'Fix bug\n\nDetails here\n\nReference: https://example.com/1',
	);
	const msg = todoAssignMessage({ id: 'todo_1', title: 'Ship "v2" & <clean>', description: 'Line 1 & <tag>' });
	const parsed = parseTodoAssign(msg);
	assert.equal(parsed?.title, 'Ship "v2" & <clean>');
	assert.equal(parsed?.body, 'Line 1 & <tag>');
});
