import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-todos-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { todosFor, writeTodos } = await import('../src/services/todos.ts');
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
	assert.equal(first, 'Todo list saved: 1/3 done. Now: Fix the bug');
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
