import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-todos-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const v = await import('valibot');
const { changeTodos, noteTodoStep, startTodoReply, TODOS_INPUT, todoReminded, todoReminder, todosFor, updateTodos, writeTodos } = await import('../src/services/todos.ts');
const { completionGate, startCompletionGate } = await import('../src/services/completion-gate.ts');
const { setProviders } = await import('../src/providers/index.ts');
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
	assert.match(reminder ?? '', /Do the ones you can still do now: a step that is only large or slow is still yours to finish\. .*call update_todos/);
	// A step is left open only for something the user must give, and the reply says what; never because it "cannot be done".
	assert.match(reminder ?? '', /Leave a step open only when it needs something from the user \(a decision, access, a file\), and then say in your reply exactly what it needs\./);
	assert.doesNotMatch(reminder ?? '', /cannot be done/);
	assert.equal(todoReminded('t'), true);
	// Once per reply, so a list the agent leaves open on purpose does not hold the reply up.
	assert.equal(await todoReminder('t', calls), null);
	startTodoReply('t');
	assert.equal(todoReminded('t'), false);
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

test('a finished step keeps how it was checked, trimmed to a line, and a step without evidence has none', async () => {
	await writeTodos('t', [
		{ content: 'Add the --reverse flag', status: 'completed', evidence: '  ran `sort --reverse a b`\n  printed b a ' },
		{ content: 'Run the tests', status: 'pending', evidence: '   ' },
	], new Date('2026-11-01T00:00:00Z'));
	assert.deepEqual((await todosFor('t'))?.todos, [
		{ content: 'Add the --reverse flag', status: 'completed', evidence: 'ran `sort --reverse a b` printed b a' },
		{ content: 'Run the tests', status: 'pending' },
	]);
});

const SIX = [
	{ content: 'Read the parser and its tests', status: 'completed', evidence: 'read src/parse.ts and tests/parse.test.ts; the flag is parsed in parseArgs' },
	{ content: 'Add the --reverse flag', status: 'completed', evidence: 'ran `node cli.js sort --reverse a b c`, printed c b a' },
	{ content: 'Keep the default order without the flag', status: 'in_progress' },
	{ content: 'Reject --reverse with --unique', status: 'pending' },
	{ content: 'Add tests for each option', status: 'pending' },
	{ content: 'Run the whole suite', status: 'pending' },
] as const;

const six = () => writeTodos('t', SIX.map((todo) => ({ ...todo })), new Date('2026-11-12T00:00:00Z'));

test('changes set the status and evidence of the items named by number, and leave every other item as it was saved', async () => {
	await six();
	const before = (await todosFor('t'))!.todos;
	const answer = await changeTodos('t', [
		{ item: 3, status: 'completed', evidence: '  ran `node cli.js sort a b c`,\n printed a b c ' },
		{ item: 4, status: 'in_progress' },
	], new Date('2026-11-12T00:01:00Z'));
	assert.equal(answer, 'Todo list saved: 3/6 done. Now: 4. Reject --reverse with --unique. Update it again as soon as a step finishes.');
	const after = (await todosFor('t'))!;
	assert.equal(after.updatedAt, '2026-11-12T00:01:00.000Z');
	assert.deepEqual(after.todos[2], { content: 'Keep the default order without the flag', status: 'completed', evidence: 'ran `node cli.js sort a b c`, printed a b c' });
	assert.deepEqual(after.todos[3], { content: 'Reject --reverse with --unique', status: 'in_progress' });
	for (const index of [0, 1, 4, 5]) assert.equal(JSON.stringify(after.todos[index]), JSON.stringify(before[index]), `item ${index + 1}`);
});

test('a step marked completed keeps the evidence it had; one set back to pending or in_progress keeps none unless sent', async () => {
	await six();
	await changeTodos('t', [{ item: 2, status: 'completed' }]);
	assert.equal((await todosFor('t'))!.todos[1].evidence, SIX[1].evidence);
	await changeTodos('t', [{ item: 2, status: 'in_progress' }]);
	assert.deepEqual((await todosFor('t'))!.todos[1], { content: 'Add the --reverse flag', status: 'in_progress' });
	await changeTodos('t', [{ item: 1, status: 'pending', evidence: 'the parser moved; read it again' }]);
	assert.deepEqual((await todosFor('t'))!.todos[0], { content: 'Read the parser and its tests', status: 'pending', evidence: 'the parser moved; read it again' });
	// Evidence is cleaned and cut as a whole list's is.
	await changeTodos('t', [{ item: 6, status: 'completed', evidence: `ran it ${'x'.repeat(400)}` }]);
	assert.equal((await todosFor('t'))!.todos[5].evidence?.length, 300);
	// Blank evidence is no evidence: a completed step keeps what it had.
	await changeTodos('t', [{ item: 6, status: 'completed', evidence: '   ' }]);
	assert.equal((await todosFor('t'))!.todos[5].evidence?.length, 300);
});

test('a change to an item not on the list changes nothing, and the error lists the items by number', async () => {
	await six();
	const saved = JSON.stringify(await todosFor('t'));
	for (const item of [7, 0, -1]) {
		await assert.rejects(changeTodos('t', [{ item: 3, status: 'completed' }, { item, status: 'in_progress' }]), (error: Error) => {
			assert.equal(
				error.message,
				`There is no item ${item}: your todo list has 6 items, numbered from 1:\n` +
					'1. Read the parser and its tests (completed)\n2. Add the --reverse flag (completed)\n3. Keep the default order without the flag (in_progress)\n' +
					'4. Reject --reverse with --unique (pending)\n5. Add tests for each option (pending)\n6. Run the whole suite (pending)\nNothing was changed.',
			);
			return true;
		});
	}
	assert.ok(JSON.stringify(await todosFor('t')) === saved, 'the list is as it was');
});

test('changes with no list say to write it whole first', async () => {
	await writeTodos('t', []);
	await assert.rejects(changeTodos('t', [{ item: 1, status: 'completed' }]), { message: 'There is no todo list yet. Write it whole with todos.' });
	assert.equal(await todosFor('t'), null);
});

test('the last change of a list says it is all done', async () => {
	await writeTodos('t', [{ content: 'Ship it', status: 'in_progress' }]);
	assert.equal(await changeTodos('t', [{ item: 1, status: 'completed', evidence: 'pushed' }]), 'Todo list saved: all 1 done.');
});

test('two updates of one list in the same step both land', async () => {
	await six();
	const answers = await Promise.all([
		changeTodos('t', [{ item: 3, status: 'completed', evidence: 'checked' }]),
		updateTodos('t', { changes: [{ item: 4, status: 'in_progress' }] }),
		changeTodos('t', [{ item: 5, status: 'completed', evidence: 'added' }]),
	]);
	assert.equal(answers.length, 3);
	assert.deepEqual(
		(await todosFor('t'))!.todos.map((todo) => todo.status),
		['completed', 'completed', 'completed', 'in_progress', 'completed', 'pending'],
	);
	// A whole list written in the same step takes its turn too, and a change after it reads it.
	await Promise.all([
		updateTodos('t', { todos: [{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }] }),
		updateTodos('t', { changes: [{ item: 2, status: 'in_progress' }] }),
	]);
	assert.deepEqual((await todosFor('t'))!.todos.map((todo) => todo.status), ['in_progress', 'in_progress']);
});

test('the tool takes the whole list or the changes, and says what to send when given neither or both', async () => {
	const todos = [{ content: 'Read the code', status: 'in_progress' }];
	const changes = [{ item: 1, status: 'completed', evidence: 'read it' }];
	assert.equal(v.safeParse(TODOS_INPUT, { todos }).success, true);
	assert.equal(v.safeParse(TODOS_INPUT, { changes }).success, true);
	assert.equal(v.safeParse(TODOS_INPUT, { changes: [] }).success, false);
	assert.equal(v.safeParse(TODOS_INPUT, { changes: [{ item: 1, status: 'done' }] }).success, false);
	assert.equal(v.safeParse(TODOS_INPUT, { changes: [{ item: 1.5, status: 'completed' }] }).success, false);
	assert.equal(await updateTodos('t', v.parse(TODOS_INPUT, { todos })), 'Todo list saved: 0/1 done. Now: Read the code. Update it again as soon as a step finishes.');
	assert.equal(await updateTodos('t', v.parse(TODOS_INPUT, { changes })), 'Todo list saved: all 1 done.');
	const saved = JSON.stringify(await todosFor('t'));
	await assert.rejects(updateTodos('t', v.parse(TODOS_INPUT, {})), {
		message: 'Give changes, each an item by its number with its new status, or the whole list as todos.',
	});
	await assert.rejects(updateTodos('t', v.parse(TODOS_INPUT, { todos, changes })), {
		message: 'Give todos or changes, not both: todos replaces the whole list, changes updates items of the saved one by number. Nothing was changed.',
	});
	assert.ok(JSON.stringify(await todosFor('t')) === saved, 'neither changed the list');
});

test('a whole list sent through the tool is saved and answered exactly as writeTodos does', async () => {
	const todos = SIX.map((todo) => ({ ...todo }));
	const direct = await writeTodos('t', todos, new Date('2026-11-12T00:00:00Z'));
	const directList = JSON.stringify(await todosFor('t'));
	const tool = await updateTodos('t', v.parse(TODOS_INPUT, { todos }), 'call-whole', new Date('2026-11-12T00:00:00Z'));
	assert.equal(tool, direct);
	assert.ok(JSON.stringify(await todosFor('t')) === directList);
});

test('marking one step done and the next in progress by number takes under a third of the characters of the whole list', () => {
	const evidence = 'ran `node cli.js sort a b c`, printed a b c';
	const whole = SIX.map((todo, index) => (index === 2 ? { ...todo, status: 'completed', evidence } : index === 3 ? { ...todo, status: 'in_progress' } : todo));
	const byWhole = JSON.stringify({ todos: whole }).length;
	const byChanges = JSON.stringify({ changes: [{ item: 3, status: 'completed', evidence }, { item: 4, status: 'in_progress' }] }).length;
	assert.ok(byChanges * 3 < byWhole, `${byChanges} of ${byWhole} characters`);
});

/** A model step's output as the runtime reports it, with a tool call for each name. */
const turn = (...names: string[]) => ({
	type: 'turn',
	response: { output: { content: [{ type: 'text', text: 'Next.' }, ...names.map((name, index) => ({ type: 'toolCall', id: `${name}-${index}-${names.length}`, name }))] } },
});

test('an update that was its step only call, with steps still open, is saved and asks for the next to come with other calls', async () => {
	const NOTE = " Send the next update with your next step's other tool calls, not as a step of its own.";
	await six();
	noteTodoStep(turn('update_todos'));
	const lone = await updateTodos('t', { changes: [{ item: 3, status: 'completed', evidence: 'checked' }] }, 'update_todos-0-1');
	assert.equal(lone, `Todo list saved: 3/6 done. Update it again as soon as a step finishes.${NOTE}`);
	assert.equal((await todosFor('t'))!.todos[2].status, 'completed');
	// Once: the note is for that call alone.
	assert.equal((await updateTodos('t', { changes: [{ item: 4, status: 'in_progress' }] }, 'update_todos-0-1')).endsWith(NOTE), false);
	// Sent with other calls, it says nothing more.
	noteTodoStep(turn('update_todos', 'bash'));
	assert.equal((await updateTodos('t', { changes: [{ item: 4, status: 'completed' }] }, 'update_todos-0-2')).endsWith(NOTE), false);
	// A whole list alone is told the same.
	noteTodoStep(turn('update_todos'));
	assert.ok((await updateTodos('t', { todos: SIX.map((todo) => ({ ...todo })) }, 'update_todos-0-1')).endsWith(NOTE));
	// The last update of a reply comes alone, with nothing left open: no note.
	noteTodoStep(turn('update_todos'));
	assert.equal(await updateTodos('t', { changes: [3, 4, 5, 6].map((item) => ({ item, status: 'completed' as const })) }, 'update_todos-0-1'), 'Todo list saved: all 6 done.');
	// A call no step was noted for, and other events, add nothing.
	noteTodoStep({ type: 'tool_start' });
	assert.equal((await updateTodos('t', { changes: [{ item: 6, status: 'pending' }] }, 'never-noted')).endsWith(NOTE), false);
});

test('the checks at a reply end see a list changed by number exactly as one written whole', async () => {
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'x', list: async () => [] }, text: null, decisions: null });
	const calls = [
		{ tool: 'update_todos', isError: false },
		{ tool: 'bash', isError: false },
		{ tool: 'update_todos', isError: false },
	];
	const deps = { ending: () => 'I stopped here.', patch: async () => 'diff', reminded: () => true, request: () => 'Add --reverse', elapsed: () => 60_000, limitMs: 3_600_000, messages: () => 0 };
	const outcome = async () => {
		startTodoReply('t');
		const reminder = await todoReminder('t', calls);
		startCompletionGate('t');
		const back = await completionGate('t', calls, { chat: false, workspace: true }, deps);
		return { reminder, back };
	};
	const whole = SIX.map((todo, index) => (index === 2 ? { ...todo, status: 'completed' as const } : index === 3 ? { ...todo, status: 'in_progress' as const } : { ...todo }));
	await writeTodos('t', whole);
	const written = await outcome();
	await six();
	await changeTodos('t', [{ item: 3, status: 'completed' }, { item: 4, status: 'in_progress' }]);
	const changed = await outcome();
	assert.deepEqual(changed, written);
	assert.match(changed.reminder ?? '', /still shows 3 of 6 steps not done: "Reject --reverse with --unique", "Add tests for each option", "Run the whole suite"/);
	assert.match(changed.back ?? '', /your todo list has 3 steps open/);
	// Every step ticked off by number: neither check has anything to say.
	await changeTodos('t', [4, 5, 6].map((item) => ({ item, status: 'completed' as const })));
	assert.deepEqual(await outcome(), { reminder: null, back: null });
});
