import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { createClient } from '@libsql/client';
import * as v from 'valibot';
import type { DecisionModel, GitHost, ModelCatalog, ModelInfo, Question } from '../src/core/ports.ts';
import { quotedFrom } from '../src/core/briefs.ts';
import { shortTodoId, todoStartMessage, todoThreadFiles, type SpaceTodo } from '../src/core/space-todos.ts';
import { CREATE_TODO, EDIT_TODO } from '../src/routes/space-todo-input.ts';

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
const allModels = [model('openrouter/test/cheap'), model('openrouter/test/strong', true), model('openrouter/test/default')];
const fullCatalog = Promise.resolve(allModels);
let catalog = fullCatalog;
const fakeCatalog: ModelCatalog = {
	name: 'fake',
	list: () => catalog,
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
const { coordinatorBrief, primeCoordinator, stateBlock } = await import('../src/services/projects/coordinator.ts');
const { generalSettings } = await import('../src/services/models/general.ts');
const { migrate } = await import('../src/db/migrations.ts');
const sessions = await import('../src/services/tasks/sessions.ts');
const { spaceRoutes } = await import('../src/routes/spaces.ts');
const { attachToProject } = await import('../src/services/artifacts/attachments.ts');
const { splitAttachments } = await import('../src/core/attachments.ts');
const { removeSpaceFile } = await import('../src/services/projects/space-files.ts');

useDatabase(createClient({ url: `file:${path.join(dir, 'anton.db')}` }));
/** Answers the repository question with `pick` (the option for that repository, or 'unclear') at `p`; fails when null. */
let repoAnswer: { pick: string; p: number } | null = null;
const repoQuestions: Array<{ state: Record<string, unknown>; question: Question }> = [];
const fakeDecisions: DecisionModel = {
	name: 'fake/jev',
	async decide(state, questions) {
		const question = questions.repo;
		if (!question || question.type !== 'choice' || !repoAnswer) throw new Error('no answer');
		repoQuestions.push({ state, question });
		const option = repoAnswer.pick === 'unclear' ? 'unclear' : Object.entries(question.options).find(([, text]) => text.includes(repoAnswer!.pick))?.[0];
		if (!option) throw new Error(`no option for ${repoAnswer.pick}`);
		return { answers: { repo: { choice: option, probabilities: { [option]: repoAnswer.p } } }, inputTokens: 120, cost: 0.00001 };
	},
};

setProviders({ sandbox: localSandboxProvider(path.join(dir, 'data')), store: diskStore(path.join(dir, 'data', 'objects')), git: fakeHost, models: fakeCatalog, decisions: fakeDecisions });

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
	return `sub-${toCoordinator.length}`;
}, 'coordinator');

beforeEach(() => {
	toThreads.length = 0;
	toCoordinator.length = 0;
	failCoordinator = false;
	catalog = fullCatalog;
	repoAnswer = null;
	repoQuestions.length = 0;
});

const apiRepo = await addProject('acme/api');
const webRepo = await addProject('acme/web');
const threadRepos = await import('../src/services/projects/thread-repos.ts');
const { getSessionRecord, updateSession } = await import('../src/db/sessions.ts');

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

	const { todo, submissionId } = await todos.startTodo(space.id, item.id, 'coordinator');
	assert.equal(submissionId, 'sub-1', 'the handoff returns the id of the submission the coordinator accepted');
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

test('the model migration leaves pre-existing to-dos on the project default', async () => {
	const db = createClient({ url: ':memory:' });
	try {
		await migrate(db, 48);
		await db.execute("INSERT INTO space_todos (id, space_id, title, created_at, updated_at) VALUES ('legacy', 'project', 'Legacy to-do', '', '')");
		await migrate(db);
		assert.equal((await db.execute("SELECT thread_model_json FROM space_todos WHERE id = 'legacy'")).rows[0]?.thread_model_json, null);
	} finally {
		db.close();
	}
});

test('the to-do write schemas copy only supported fields at every level', () => {
	const extra = { nested: [{ unknown: { data: true } }] };
	const attachment = { name: 'details.txt', path: 'details.txt', kind: 'Text', size: 12 };
	const threadModel = { model: 'openrouter/test/cheap#sort=latency', reasoning: 'low' };
	const values = { title: 'Write the docs', description: 'One section', attachments: [{ ...attachment, extra }], threadModel: { ...threadModel, extra }, id: extra, extra };
	const safe = { title: values.title, description: values.description, attachments: [attachment], threadModel };
	assert.deepEqual(v.parse(CREATE_TODO, { ...values, status: 'done' }), safe);
	assert.deepEqual(v.parse(EDIT_TODO, { ...values, status: 'done' }), { ...safe, status: 'done' });
	assert.deepEqual(v.parse(EDIT_TODO, { threadModel: null }), { threadModel: null });
	for (const schema of [CREATE_TODO, EDIT_TODO]) {
		for (const wrongType of [{ title: extra }, { description: extra }, { attachments: [{ ...attachment, size: extra }] }, { threadModel: { ...threadModel, model: extra } }]) {
			assert.equal(v.safeParse(schema, { title: values.title, ...wrongType }).success, false);
		}
	}
});

test('a to-do model is round-tripped on create and edit, kept on unrelated edits, and cleared with null', async () => {
	const space = await spaces.createSpace({ name: 'Todo API models' });
	const url = `/api/spaces/${space.id}/todos`;
	const call = async <T = SpaceTodo>(method: string, tail: string, payload?: unknown): Promise<T> => {
		const response = await spaceRoutes.request(`${url}${tail}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
		assert.equal(response.status, 200);
		return response.json() as Promise<T>;
	};
	const choice = { model: 'openrouter/test/cheap#sort=latency', reasoning: 'low' } as const;
	const item = await call('POST', '', { title: 'Tune the API', threadModel: choice });
	assert.deepEqual(item.threadModel, choice);
	const tail = `/${item.id}`;
	assert.deepEqual((await call('PATCH', tail, { description: 'One endpoint at a time.' })).threadModel, choice);
	const changed = { model: 'openrouter/test/strong', reasoning: null };
	assert.deepEqual((await call('PATCH', tail, { threadModel: changed })).threadModel, changed);
	await assert.rejects(() => todos.editTodo(space.id, item.id, { threadModel: { model: 'openrouter/test/missing', reasoning: null } }), /Unknown model/);
	assert.deepEqual((await call<{ todos: SpaceTodo[] }>('GET', '')).todos[0].threadModel, changed);
	assert.equal((await call('PATCH', tail, { threadModel: null })).threadModel, null);
	assert.equal((await call<{ todos: SpaceTodo[] }>('GET', '')).todos[0].threadModel, null);
});

test('an unavailable to-do model blocks a coordinator handoff without admitting it or changing the to-do', async () => {
	const space = await spaces.createSpace({ name: 'Delisted to-do model' });
	const threadModel = { model: 'openrouter/test/cheap#sort=latency', reasoning: 'low' } as const;
	const item = await todos.createTodo(space.id, { title: 'Tune the API', threadModel });
	catalog = Promise.resolve(allModels.filter((entry) => entry.id !== 'openrouter/test/cheap'));

	await assert.rejects(() => todos.startTodo(space.id, item.id, 'coordinator'), {
		status: 400,
		message: 'Unknown model: openrouter/test/cheap#sort=latency. Choose a different main thread model or use the project default.',
	});
	assert.equal(toCoordinator.length, 0);
	assert.deepEqual(await todos.listTodos(space.id), [item]);
	assert.deepEqual((await todos.editTodo(space.id, item.id, { title: 'Tune the API again' })).threadModel, threadModel);

	await todos.editTodo(space.id, item.id, { threadModel: null });
	const started = await todos.startTodo(space.id, item.id, 'coordinator');
	assert.equal(started.submissionId, 'sub-1');
	assert.deepEqual([started.todo.status, started.todo.assignee], ['in_progress', 'coordinator']);
});

test('direct and coordinator to-dos keep distinct models, even in the queue, without changing any defaults or existing threads', async () => {
	const space = await spaces.createSpace({ name: 'Todo thread models', repoIds: [apiRepo.id], maxParallel: 5 });
	const defaults = { coordinatorModel: 'openrouter/test/cheap', coordinatorReasoning: 'low', threadModel: 'openrouter/test/default', threadReasoning: 'low' } as const;
	await spaces.editSpace(space.id, defaults);
	const general = await generalSettings();
	const existing = await spaces.startThread(space.id, { title: 'Existing thread', brief: 'Continue as before' });
	await spaces.editSpace(space.id, { state: 'paused' });
	const direct = await todos.createTodo(space.id, { title: 'Small fix', threadModel: { model: 'openrouter/test/cheap#sort=latency', reasoning: null } });
	const handed = await todos.createTodo(space.id, { title: 'Large split task', threadModel: { model: 'openrouter/test/strong', reasoning: 'low' } });
	const inherited = await todos.createTodo(space.id, { title: 'Use defaults' });
	const [directResult] = await Promise.all([todos.startTodo(space.id, direct.id, 'thread'), todos.startTodo(space.id, handed.id, 'coordinator')]);
	assert.deepEqual([coordinatorBrief(space.id).model, coordinatorBrief(space.id).reasoning], [defaults.coordinatorModel, defaults.coordinatorReasoning]);
	const handoff = { entries: [{ id: shortTodoId(handed.id), text: toCoordinator[0].text }], latestIsHandoff: true };
	const ordinary = { entries: [], latestIsHandoff: false };
	assert.match(await stateBlock(space.id), /"Large split task" · started, no thread yet · main thread model: openrouter\/test\/strong/);
	const taken = (await todos.coordinatorTodo(space.id, handoff))?.todo;
	assert.equal(taken?.id, handed.id, 'the saved handoff identifies the to-do without a tool argument');
	assert.equal((await todos.coordinatorTodo(space.id, handoff, direct.id))?.todo.id, handed.id, 'a wrong tool argument cannot pick another model');
	assert.equal(await todos.coordinatorTodo(space.id, ordinary), null);
	assert.equal((await todos.coordinatorTodo(space.id, ordinary, handed.id))?.todo.id, handed.id);
	assert.equal(await todos.coordinatorTodo(space.id, { ...handoff, latestIsHandoff: false }), null, 'an ordinary delivery that joins need not act on the single earlier handoff');
	await assert.rejects(() => todos.messageTodoThread(taken!, existing.id, 'Wrong thread'), /Use start_thread/);
	assert.equal(toThreads.some((entry) => entry.text === 'Wrong thread'), false);
	const first = await todos.startTodoThread(taken!, { title: 'Part one', brief: 'Start the first part' });
	const second = await todos.startTodoThread(taken!, { title: 'Part two', brief: 'Start the second part' });
	assert.equal(second.todo.threads, 2);
	const fallback = (await todos.startTodo(space.id, inherited.id, 'thread')).thread!;
	for (const thread of [directResult.thread!, first.thread, second.thread, fallback]) assert.equal(thread.threadState, 'queued');
	assert.deepEqual([directResult.thread!.model, directResult.thread!.reasoning, directResult.thread!.route], ['openrouter/test/cheap', null, { sort: 'latency' }]);
	for (const { thread } of [first, second]) assert.deepEqual([thread.model, thread.reasoning], ['openrouter/test/strong', 'low']);
	assert.deepEqual([fallback.model, fallback.reasoning], [defaults.threadModel, defaults.threadReasoning]);
	const resumed = await spaces.editSpace(space.id, { state: 'active' });
	assert.deepEqual(sessions.agentModelFor(directResult.thread!.id), { model: 'openrouter/test/cheap#sort=latency', reasoning: 'high', route: { sort: 'latency' } });
	assert.deepEqual(sessions.agentModelFor(first.thread.id), { model: 'openrouter/test/strong', reasoning: 'low' });
	assert.deepEqual(sessions.agentModelFor(second.thread.id), { model: 'openrouter/test/strong', reasoning: 'low' });
	assert.deepEqual(sessions.agentModelFor(existing.id), { model: defaults.threadModel, reasoning: defaults.threadReasoning });
	for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) assert.equal(resumed[key], defaults[key]);
	assert.deepEqual(await generalSettings(), general);
});

test('the real coordinator tools keep a board handoff after the project-state signal', async () => {
	const { Coordinator } = await import('../src/agents/coordinator.ts');
	const faux = fauxProvider({ provider: 'coordinator-fixture' });
	const coordinatorModel = `${faux.provider.id}/${faux.getModel().id}`;
	catalog = Promise.resolve([...allModels, model(coordinatorModel)]);
	const space = await spaces.createSpace({ name: 'Tool delivery' });
	await spaces.editSpace(space.id, { coordinatorModel, threadModel: 'openrouter/test/default', threadReasoning: 'low', state: 'paused' });
	const existing = await spaces.startThread(space.id, { title: 'Existing thread', brief: 'Original work' });
	const boardTodo = await todos.createTodo(space.id, { title: 'Ship billing v2', threadModel: { model: 'openrouter/test/strong#sort=latency', reasoning: 'high' } });
	const unrelated = await todos.createTodo(space.id, { title: 'Not this to-do' });
	await todos.startTodo(space.id, boardTodo.id, 'coordinator');

	const runtime = await start({ agents: [Coordinator], providers: [faux.provider] });
	try {
		const agent = init(Coordinator, { id: space.id });
		let sawStateSignal = false;
		faux.setResponses([
			({ messages }) => {
				sawStateSignal = messages.some((message) => message.role === 'user' && (
					typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
				).startsWith('<signal type="project-state">'));
				return fauxAssistantMessage([
					fauxToolCall('message_thread', { thread: existing.id, message: 'Do not reroute' }, { id: 'message-omitted' }),
					fauxToolCall('message_thread', { thread: existing.id, message: 'Do not reroute', todo_id: unrelated.id }, { id: 'message-wrong' }),
					fauxToolCall('start_thread', { title: 'Part one', request: boardTodo.title }, { id: 'start-omitted' }),
					fauxToolCall('start_thread', { title: 'Part two', request: boardTodo.title, todo_id: unrelated.id }, { id: 'start-wrong' }),
				], { stopReason: 'toolUse' });
			},
			fauxAssistantMessage([fauxText('Started both parts.')]),
		]);
		const rejectedNudges: string[] = [];
		const receipt = await agent.dispatch(toCoordinator[0].text);
		await agent.read(receipt, {
			signal: AbortSignal.timeout(5000),
				onEvent(event) {
				if (event.type === 'tool-output-error' && event.errorText.includes('Use start_thread')) rejectedNudges.push(event.toolCallId);
			},
		});
		assert.equal(sawStateSignal, true, 'the model received the project-state signal before making those calls');
		assert.deepEqual(rejectedNudges.sort(), ['message-omitted', 'message-wrong']);
		const threads = await sessions.listThreads(space.id);
		for (const title of ['Part one', 'Part two']) {
			const thread = threads.find((item) => item.title === title);
			assert.deepEqual([thread?.model, thread?.reasoning, thread?.route, thread?.threadState], ['openrouter/test/strong', 'high', { sort: 'latency' }, 'queued']);
		}
		assert.equal(threads.find((thread) => thread.id === existing.id)?.brief, 'Original work');
		const listed = await todos.listTodos(space.id);
		assert.equal(listed.find((item) => item.id === boardTodo.id)?.threads, 2);
		assert.equal(listed.find((item) => item.id === unrelated.id)?.threads, 0);

		await primeCoordinator(space.id);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall('start_thread', { title: 'Unrelated work', request: 'Check the dashboard' })], { stopReason: 'toolUse' }),
			fauxAssistantMessage([fauxText('Started a thread.')]),
		]);
		const followUp = await agent.dispatch('Check the dashboard');
		await agent.read(followUp, { signal: AbortSignal.timeout(5000) });
		assert.equal((await sessions.listThreads(space.id)).find((thread) => thread.title === 'Unrelated work')?.model, 'openrouter/test/default');
		assert.equal((await todos.listTodos(space.id)).find((item) => item.id === boardTodo.id)?.threads, 2);
	} finally {
		await runtime.stop();
	}
});

test('two board handoffs join one coordinator reply before its tools run and each supplies its own model and files', async () => {
	const { Coordinator } = await import('../src/agents/coordinator.ts');
	const faux = fauxProvider({ provider: 'joined-coordinator-fixture' });
	const coordinatorModel = `${faux.provider.id}/${faux.getModel().id}`;
	catalog = Promise.resolve([...allModels, model(coordinatorModel)]);
	const space = await spaces.createSpace({ name: 'Joined board handoffs' });
	const defaults = 'openrouter/test/default';
	await spaces.editSpace(space.id, { coordinatorModel, threadModel: defaults, state: 'paused' });
	const existing = await spaces.startThread(space.id, { title: 'Existing thread', brief: 'Leave this thread alone' });
	const firstFile = await attachToProject(space.id, 'migration.txt', new TextEncoder().encode('Migration requirements'), 'text/plain');
	const secondFile = await attachToProject(space.id, 'dashboard.txt', new TextEncoder().encode('Dashboard requirements'), 'text/plain');
	const first = await todos.createTodo(space.id, { title: 'Ship the migration', attachments: [firstFile], threadModel: { model: 'openrouter/test/strong#sort=latency', reasoning: 'high' } });
	const second = await todos.createTodo(space.id, { title: 'Update the dashboard', attachments: [secondFile], threadModel: { model: 'openrouter/test/cheap', reasoning: 'low' } });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const runtime = await start({ agents: [Coordinator], providers: [faux.provider] });
	try {
		const agent = init(Coordinator, { id: space.id });
		let bothInContext = false;
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage('Ready for work.');
			},
			({ messages }) => {
				const context = JSON.stringify(messages);
				bothInContext = [first, second].every((todo) => context.includes(todoStartMessage(todo)));
				return fauxAssistantMessage([
					fauxToolCall('start_thread', { title: 'No ID', request: first.title }, { id: 'missing-start-id' }),
					fauxToolCall('message_thread', { thread: existing.id, message: first.title, todo_id: 'not-a-handoff' }, { id: 'unknown-message-id' }),
					fauxToolCall('start_thread', { title: 'Crossed IDs', request: first.title, todo_id: second.id, approved: true }, { id: 'wrong-brief' }),
					fauxToolCall('message_thread', { thread: existing.id, message: first.title, todo_id: first.id }, { id: 'override-message' }),
					fauxToolCall('start_thread', { title: 'Migration', request: first.title, todo_id: `[todo:${shortTodoId(first.id)}]` }),
					fauxToolCall('start_thread', { title: 'Dashboard', request: second.title, todo_id: second.id }),
				], { stopReason: 'toolUse' });
			},
			fauxAssistantMessage('Started both to-dos.'),
		]);
		await primeCoordinator(space.id);
		const host = await agent.dispatch('Show what is ready to start.');
		const signal = AbortSignal.timeout(5000);
		const answeredBy = new Map<string, string | undefined>();
		const toolErrors = new Map<string, string>();
		const reply = agent.read(host, { signal, onEvent(event) {
			if (event.type === 'submission-settled') answeredBy.set(event.submissionId, event.answeredBySubmissionId);
			if (event.type === 'tool-output-error') toolErrors.set(event.toolCallId, event.errorText);
		} });
		await Promise.race([entered.promise, reply.then(() => { throw new Error('The coordinator settled before its first model call'); })]);
		const joins = [];
		for (const todo of [first, second]) {
			await todos.startTodo(space.id, todo.id, 'coordinator');
			joins.push(await agent.dispatch(toCoordinator.at(-1)!.text));
		}
		release.resolve();
		await reply;
		assert.ok(bothInContext, 'both handoffs reached the model before it made any tool calls');
		for (const join of joins) assert.equal(answeredBy.get(join.submissionId), host.submissionId);
		assert.match(toolErrors.get('missing-start-id') ?? '', /matching todo_id/);
		assert.match(toolErrors.get('unknown-message-id') ?? '', /matching todo_id/);
		assert.match(toolErrors.get('wrong-brief') ?? '', /not the user's words/);
		assert.match(toolErrors.get('override-message') ?? '', /Use start_thread/);
		const threads = await sessions.listThreads(space.id);
		assert.equal(threads.length, 3, 'only the two correctly identified starts created threads');
		assert.equal(threads.find(({ id }) => id === existing.id)?.brief, 'Leave this thread alone');
		const migration = threads.find(({ title }) => title === 'Migration')!;
		const dashboard = threads.find(({ title }) => title === 'Dashboard')!;
		assert.deepEqual([migration.model, migration.reasoning, migration.route], ['openrouter/test/strong', 'high', { sort: 'latency' }]);
		assert.deepEqual([dashboard.model, dashboard.reasoning, dashboard.route], ['openrouter/test/cheap', 'low', null]);
		assert.deepEqual(splitAttachments(migration.brief!).files.map(({ path }) => path), [firstFile.path]);
		assert.deepEqual(splitAttachments(dashboard.brief!).files.map(({ path }) => path), [secondFile.path]);
		const byId = new Map((await todos.listTodos(space.id)).map((todo) => [todo.id, todo]));
		assert.equal(byId.get(first.id)?.threads, 1);
		assert.equal(byId.get(second.id)?.threads, 1);
		await sessions.editSession(migration.id, { resolved: true });
		const settled = new Map((await todos.listTodos(space.id)).map((todo) => [todo.id, todo.status]));
		assert.deepEqual([settled.get(first.id), settled.get(second.id)], ['done', 'in_progress']);
	} finally {
		release.resolve();
		await runtime.stop();
	}
});

test('an inferred to-do joining an ordinary coordinator reply carries its resolved ID on both thread actions', async () => {
	const { Coordinator } = await import('../src/agents/coordinator.ts');
	const faux = fauxProvider({ provider: 'inferred-coordinator-fixture' });
	const coordinatorModel = `${faux.provider.id}/${faux.getModel().id}`;
	catalog = Promise.resolve([...allModels, model(coordinatorModel)]);
	const space = await spaces.createSpace({ name: 'Inferred handoff' });
	await spaces.editSpace(space.id, { coordinatorModel, state: 'paused' });
	const existing = await spaces.startThread(space.id, { title: 'Existing thread', brief: 'Original work' });
	const todo = await todos.createTodo(space.id, { title: 'Fix duplicate invoices' });
	const other = await todos.createTodo(space.id, { title: 'An unrelated to-do' });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const runtime = await start({ agents: [Coordinator], providers: [faux.provider] });
	try {
		const agent = init(Coordinator, { id: space.id });
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage('Here is the status.');
			},
			fauxAssistantMessage([
				fauxToolCall('start_thread', { title: 'Fix invoices', request: todo.title }, { id: 'inferred-start' }),
				fauxToolCall('message_thread', { thread: existing.id, message: todo.title, todo_id: other.id }, { id: 'inferred-message' }),
			], { stopReason: 'toolUse' }),
			fauxAssistantMessage('The invoice work is underway.'),
		]);
		await primeCoordinator(space.id);
		const host = await agent.dispatch('What is running?');
		const outputs = new Map<string, unknown>();
		const answeredBy = new Map<string, string | undefined>();
		const reply = agent.read(host, { signal: AbortSignal.timeout(5000), onEvent(event) {
			if (event.type === 'tool-output') outputs.set(event.toolCallId, event.output);
			if (event.type === 'submission-settled') answeredBy.set(event.submissionId, event.answeredBySubmissionId);
		} });
		await Promise.race([entered.promise, reply.then(() => { throw new Error('The coordinator settled before the handoff'); })]);
		await todos.startTodo(space.id, todo.id, 'coordinator');
		const joined = await agent.dispatch(toCoordinator.at(-1)!.text);
		release.resolve();
		await reply;
		assert.equal(answeredBy.get(joined.submissionId), host.submissionId);
		const started = (await sessions.listThreads(space.id)).find(({ title }) => title === 'Fix invoices');
		assert.ok(started);
		assert.deepEqual(outputs.get('inferred-start'), { output: `Queued thread "Fix invoices" [id:${started.id}] with no repository. It starts when a working thread finishes.`, todoId: todo.id });
		assert.deepEqual(outputs.get('inferred-message'), { output: `Sent to "Existing thread" [id:${existing.id}].`, todoId: todo.id });
		const byId = new Map((await todos.listTodos(space.id)).map((item) => [item.id, item]));
		assert.equal(byId.get(todo.id)?.threads, 2);
		assert.equal(byId.get(other.id)?.threads, 0);
	} finally {
		release.resolve();
		await runtime.stop();
	}
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

test("a to-do split over threads sends each only the files the coordinator names for it, or all of them when it names none", () => {
	const file = (name: string) => ({ name, path: name, kind: 'PNG image', size: 1 });
	const todo = { attachments: [file('chips.png'), file('repos.png'), file('sidebar.png')] };
	assert.deepEqual(todoThreadFiles(todo, ['repos.png']), ['repos.png']);
	assert.deepEqual(todoThreadFiles(todo, []), ['chips.png', 'repos.png', 'sidebar.png']);
	assert.deepEqual(todoThreadFiles(todo, undefined), ['chips.png', 'repos.png', 'sidebar.png']);
	assert.deepEqual(todoThreadFiles(null, ['notes.md']), ['notes.md']);
	assert.equal(todoThreadFiles({ attachments: [] }, undefined), undefined);
});

const contextOf = (text: string) => /<project-context>([\s\S]*?)<\/project-context>/.exec(text)?.[1] ?? '';
const briefOf = (threadId: string) => toThreads.find((sent) => sent.id === threadId)?.text ?? '';
const settleThreads = () => new Promise((resolve) => setTimeout(resolve, 50));

test('a to-do keeps the repositories it is tagged with: once each, only the project’s, cleared with an empty list', async () => {
	const space = await spaces.createSpace({ name: 'Todo repo tags', repoIds: [apiRepo.id, webRepo.id] });
	const item = await todos.createTodo(space.id, { title: 'Tagged', repos: [webRepo.id, webRepo.id, apiRepo.id] });
	assert.deepEqual(item.repos, [webRepo.id, apiRepo.id]);
	const other = await addProject('acme/other');
	await assert.rejects(() => todos.createTodo(space.id, { title: 'Elsewhere', repos: [other.id] }), /not in this project/);
	await assert.rejects(() => todos.editTodo(space.id, item.id, { repos: [other.id] }), /not in this project/);
	assert.deepEqual((await todos.editTodo(space.id, item.id, { title: 'Renamed' })).repos, [webRepo.id, apiRepo.id], 'an edit without repos keeps them');
	assert.deepEqual((await todos.editTodo(space.id, item.id, { repos: [] })).repos, []);
	assert.deepEqual(v.parse(EDIT_TODO, { repos: [apiRepo.id] }).repos, [apiRepo.id]);
	assert.equal(v.safeParse(CREATE_TODO, { title: 'x', repos: 'acme/api' }).success, false);
});

test('a to-do tagged with repositories starts one thread in each, told which is theirs and to check the fit before changing anything', async () => {
	const space = await spaces.createSpace({ name: 'Todo tagged start', repoIds: [apiRepo.id, webRepo.id], maxParallel: 5 });
	repoAnswer = { pick: 'acme/api', p: 0.99 };
	const one = await todos.createTodo(space.id, { title: 'Fix the login form', repos: [webRepo.id] });
	const started = await todos.startTodo(space.id, one.id, 'thread');
	assert.equal(repoQuestions.length, 0, 'a tagged to-do asks the decision model nothing');
	assert.equal(started.thread?.repo, 'acme/web');
	assert.equal(started.thread?.title, 'Fix the login form');
	await settleThreads();
	assert.match(contextOf(briefOf(started.thread!.id)), /tagged this to-do with acme\/web\. Before you change anything, check/);

	const both = await todos.createTodo(space.id, { title: 'Rename the session cookie', repos: [webRepo.id, apiRepo.id] });
	const split = await todos.startTodo(space.id, both.id, 'thread');
	// In the project's order, which the to-do kept.
	assert.deepEqual(split.threads?.map((thread) => [thread.repo, thread.title]), [
		['acme/web', 'Rename the session cookie (web)'],
		['acme/api', 'Rename the session cookie (api)'],
	]);
	assert.deepEqual([split.todo.status, split.todo.threads], ['in_progress', 2]);
	await settleThreads();
	const apiBrief = briefOf(split.threads![1].id);
	assert.match(apiBrief, /This thread does only this part of it, in its own pull request; other threads do the rest: its changes in acme\/api/);
	assert.match(contextOf(apiBrief), /each has a thread of its own, and this one works only in acme\/api/);
});

test('an untagged to-do in a project with several repositories goes where the decision model is sure, and otherwise starts with none and asks', async () => {
	const space = await spaces.createSpace({ name: 'Todo picked start', repoIds: [apiRepo.id, webRepo.id], maxParallel: 5 });
	repoAnswer = { pick: 'acme/web', p: 0.9 };
	const sure = await todos.createTodo(space.id, { title: 'Fix the navbar', description: 'The web app navbar overlaps on phones.' });
	const picked = await todos.startTodo(space.id, sure.id, 'thread');
	assert.equal(picked.thread?.repo, 'acme/web');
	assert.equal(repoQuestions.length, 1);
	assert.deepEqual(repoQuestions[0].state.repositories, ['acme/api', 'acme/web']);
	assert.match(String(repoQuestions[0].state.request), /navbar overlaps on phones/);
	await settleThreads();
	assert.match(contextOf(briefOf(picked.thread!.id)), /Anton picked acme\/web from its words\. The project's repositories: acme\/api, acme\/web\./);

	for (const answer of [{ pick: 'acme/web', p: 0.4 }, { pick: 'unclear', p: 0.95 }, null]) {
		repoAnswer = answer;
		const unsure = await todos.createTodo(space.id, { title: `Unsure ${answer?.pick ?? 'failed'} ${answer?.p ?? ''}` });
		const { thread } = await todos.startTodo(space.id, unsure.id, 'thread');
		assert.equal(thread?.projectId, null, `${JSON.stringify(answer)} starts a thread with no repository`);
		await settleThreads();
		assert.match(contextOf(briefOf(thread!.id)), /could not tell which of the project's repositories it belongs in: acme\/api, acme\/web\. .*use ask .* call set_repo/);
	}

	const single = await spaces.createSpace({ name: 'Todo one repo', repoIds: [apiRepo.id] });
	const plain = await todos.createTodo(single.id, { title: 'Only one place to go' });
	repoQuestions.length = 0;
	const only = await todos.startTodo(single.id, plain.id, 'thread');
	assert.equal(only.thread?.repo, 'acme/api');
	assert.equal(repoQuestions.length, 0, 'one repository needs no decision');
	await settleThreads();
	assert.equal(contextOf(briefOf(only.thread!.id)), '', 'and no note');
});

test('a to-do handed to the coordinator names its tagged repositories, and a thread it gives no repo goes to the first', async () => {
	const space = await spaces.createSpace({ name: 'Todo tagged coordinator', repoIds: [apiRepo.id, webRepo.id], maxParallel: 5 });
	const item = await todos.createTodo(space.id, { title: 'Tidy the web build', repos: [webRepo.id] });
	await todos.startTodo(space.id, item.id, 'coordinator');
	assert.match(toCoordinator[0].text, /Repositories tagged on this to-do: acme\/web\./);
	assert.match(await stateBlock(space.id), /"Tidy the web build" · .* · repositories: acme\/web/);
	const { thread } = await todos.startTodoThread((await todos.findTodo(space.id, item.id)), { title: 'Tidy', brief: 'Tidy the web build' });
	assert.equal(thread.repo, 'acme/web');
	const named = await todos.startTodoThread((await todos.findTodo(space.id, item.id)), { title: 'Tidy api', brief: 'Tidy the web build', repo: 'acme/api' });
	assert.equal(named.thread.repo, 'acme/api', 'a repo the coordinator names wins');
});

test('set_repo moves a thread that changed nothing once its reply ends, and starts the other repositories’ threads for its to-do', async () => {
	const space = await spaces.createSpace({ name: 'Todo set repo', repoIds: [apiRepo.id, webRepo.id], maxParallel: 5 });
	repoAnswer = null;
	const item = await todos.createTodo(space.id, { title: 'Where does this go' });
	const { thread } = await todos.startTodo(space.id, item.id, 'thread');
	assert.equal(thread?.projectId, null);
	await settleThreads();
	const startIn = async (todoId: string, repos: Array<{ id: string; repoFullName: string }>, from: string) =>
		(await todos.startTodoThreadsIn(todoId, repos as never, from)).map(({ id, title }) => ({ id, title }));
	await assert.rejects(() => threadRepos.setThreadRepos(thread!.id, ['acme/nowhere'], startIn), /not one of this project's repositories/);

	const result = await threadRepos.setThreadRepos(thread!.id, ['web', 'acme/api'], startIn);
	assert.equal(result.moving, true);
	assert.match(result.output, /moves to acme\/web when this reply ends/);
	assert.equal(threadRepos.pendingRepoMove(thread!.id), webRepo.id);
	const linked = (await todos.listTodos(space.id)).find((todo) => todo.id === item.id)!;
	assert.equal(linked.threads, 2, 'the api thread started for the same to-do');
	const sibling = (await sessions.listThreads(space.id)).find((other) => other.repo === 'acme/api');
	assert.ok(sibling, 'a thread in acme/api');

	toThreads.length = 0;
	await threadRepos.applyRepoMove(thread!.id);
	const moved = await getSessionRecord(thread!.id);
	assert.deepEqual([moved?.projectId, moved?.baseBranch, moved?.baseSha, moved?.machineState], [webRepo.id, 'main', 'sha-main', null]);
	assert.match(moved!.branch, /^anton\/where-does-this-go-/);
	assert.equal(threadRepos.pendingRepoMove(thread!.id), null);
	assert.match(toThreads.find((sent) => sent.id === thread!.id)?.text ?? '', /Anton moved this thread to acme\/web .* Carry on with the request there\./);

	const again = await threadRepos.setThreadRepos(thread!.id, ['acme/web'], startIn);
	assert.deepEqual(again, { moving: false, output: 'This thread already works in acme/web.' });

	await updateSession(thread!.id, { prUrl: 'https://github.com/acme/web/pull/7' });
	await assert.rejects(() => threadRepos.setThreadRepos(thread!.id, ['acme/api'], startIn), /already pushed work to acme\/web/);
	assert.equal(threadRepos.pendingRepoMove(thread!.id), null);
});
