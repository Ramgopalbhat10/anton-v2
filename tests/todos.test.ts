import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-todos-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { startTodoReply, todoReminder, todosFor, writeTodos } = await import('../src/services/todos.ts');
const { onChange } = await import('../src/core/changes.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');

const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 't', projectId: project.id, title: 'T', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });

test('a task has no todo list until the agent writes one', async () => {
	assert.equal(await todosFor('t'), null);
});

test('each list the agent writes replaces the last, and only the pill hears of it', async () => {
	const changes: unknown[] = [];
	const stop = onChange((change) => changes.push(change));
	const first = await writeTodos('t', [
		{ content: 'Read the code', status: 'completed' },
		{ content: '  Fix   the bug ', status: 'in_progress' },
		{ content: 'Run the tests', status: 'pending' },
	]);
	assert.equal(first, 'Todo list saved: 1/3 done. Now: Fix the bug. Update it again as soon as a step finishes.');
	await writeTodos('t', [{ content: 'Answer the question', status: 'in_progress' }], new Date('2026-10-13T00:00:00Z'));
	stop();
	assert.deepEqual(await todosFor('t'), { todos: [{ content: 'Answer the question', status: 'in_progress' }], updatedAt: '2026-10-13T00:00:00.000Z' });
	assert.deepEqual(changes, [
		{ kind: 'task', id: 't', what: 'todos' },
		{ kind: 'task', id: 't', what: 'todos' },
	]);
});

test('an empty list clears it', async () => {
	assert.equal(await writeTodos('t', [{ content: '   ', status: 'pending' }]), 'The todo list is cleared.');
	assert.equal(await todosFor('t'), null);
});

test('a list with every step done says so', async () => {
	assert.equal(await writeTodos('t', [{ content: 'Ship it', status: 'completed' }]), 'Todo list saved: all 1 done.');
});

test('a reply that wrote a list and ends with steps open is reminded once to bring it up to date', async () => {
	await writeTodos('t', [
		{ content: 'Build the app', status: 'in_progress' },
		{ content: 'Test it', status: 'pending' },
		{ content: 'Report back', status: 'completed' },
	]);
	const calls = [
		{ tool: 'update_todos', isError: false },
		{ tool: 'write', isError: false },
	];
	startTodoReply('t');
	const reminder = await todoReminder('t', calls);
	assert.match(reminder ?? '', /still shows 2 of 3 steps not done: "Build the app", "Test it"/);
	assert.match(reminder ?? '', /Do any of them you can still do without the user now. .*call update_todos/);
	// Once per reply, so a list the agent leaves open on purpose does not hold the reply up.
	assert.equal(await todoReminder('t', calls), null);
	startTodoReply('t');
	assert.ok(await todoReminder('t', calls));
});

test('no reminder for a list from an earlier reply, a finished list, or a reply ending on a question', async () => {
	await writeTodos('t', [{ content: 'Build the app', status: 'in_progress' }]);
	startTodoReply('t');
	assert.equal(await todoReminder('t', [{ tool: 'bash', isError: false }]), null);
	assert.equal(await todoReminder('t', [{ tool: 'update_todos', isError: true }]), null);
	assert.equal(await todoReminder('t', [{ tool: 'update_todos', isError: false }, { tool: 'ask', isError: false }]), null);
	await writeTodos('t', [{ content: 'Build the app', status: 'completed' }]);
	assert.equal(await todoReminder('t', [{ tool: 'update_todos', isError: false }]), null);
});
