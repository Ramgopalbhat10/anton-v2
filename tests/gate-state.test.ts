import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { TextModel } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-gate-state-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { setProviders } = await import('../src/providers/index.ts');
const { finishReview, noteRequest, requestFor, startFinishReview } = await import('../src/services/finish-review.ts');
const { completionGate, startCompletionGate } = await import('../src/services/completion-gate.ts');
const { recordReplyText, replyEnding, replyMessages, stallReminder, startStallCheck } = await import('../src/services/reply-check.ts');
const { elapsedNote, replyElapsed, startReplyClock } = await import('../src/services/reply-clock.ts');
const { startTodoReply, todoReminded, todoReminder, writeTodos } = await import('../src/services/todos.ts');
const { changeGate, flushGates, gate, loadGate, restartGates } = await import('../src/services/gate-state.ts');
const { getGateStateRow, saveGateStateRow } = await import('../src/db/gate-state.ts');
const { deleteSessionRecord, insertSession } = await import('../src/db/sessions.ts');
const { upsertProject } = await import('../src/db/projects.ts');

const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 't2', projectId: project.id, title: 'T', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });

let reviews = 0;
const writer: TextModel = {
	runs: () => true,
	write: async () => {
		reviews += 1;
		return { text: 'NONE', inputTokens: 1, outputTokens: 1, cost: 0 };
	},
};
setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, text: writer, decisions: null });

const DIFF = 'diff --git a/src/sort.ts b/src/sort.ts\n+export function sortBy(keys: string[]) {}\n';
const edit = [{ tool: 'bash' }, { tool: 'edit' }];
const say = (id: string, text: string) => recordReplyText({ type: 'message_end', instanceId: id, session: 'default', message: { role: 'assistant', content: text } });

test('a task’s request and what its review last read are there after a restart, so a reply that changed nothing is not reviewed', async () => {
	noteRequest('t1', 'Add sortBy(keys).');
	startFinishReview('t1');
	assert.equal(await finishReview('t1', edit, undefined, { patch: async () => DIFF }), null);
	assert.equal(reviews, 1);
	await restartGates();
	assert.equal(requestFor('t1'), undefined, 'nothing is in memory until the row is read');
	await loadGate('t1');
	assert.equal(requestFor('t1'), 'Add sortBy(keys).');
	// A new reply after the restart that left the change as it was is not reviewed again.
	startFinishReview('t1');
	assert.equal(await finishReview('t1', [{ tool: 'bash' }], undefined, { patch: async () => DIFF }), null);
	assert.equal(reviews, 1);
});

test('a reply resumed after a restart runs no start hooks: its request, rounds, flags and clock carry on', async () => {
	const t0 = Date.now() - 30 * 60_000;
	noteRequest('t2', 'Add durable wait APIs.');
	startFinishReview('t2');
	startCompletionGate('t2');
	startTodoReply('t2');
	startStallCheck('t2');
	startReplyClock('t2', t0);
	await loadGate('t2');
	await writeTodos('t2', [
		{ content: 'Add wait_for_event', status: 'in_progress' },
		{ content: 'Add durable timers', status: 'pending' },
	]);
	const todos = [{ tool: 'update_todos', isError: false }];
	assert.ok(await todoReminder('t2', todos));
	say('t2', 'I’ll start with the timers.');
	assert.ok(stallReminder('t2', edit));
	const deps = { patch: async () => '', todos: async () => null, ending: () => 'The timers are not implemented yet.', reminded: () => true, elapsed: () => 0, limitMs: 3_600_000 };
	assert.ok(await completionGate('t2', edit, { chat: false, workspace: true }, deps));
	assert.match(elapsedNote('t2', t0 + 20 * 60_000), /20m since this reply started/);
	await restartGates();
	// The runtime resumes the reply: no start hook runs, and the end of the reply is checked again.
	await loadGate('t2');
	assert.equal(requestFor('t2'), 'Add durable wait APIs.');
	assert.equal(await todoReminder('t2', todos), null, 'reminded once a reply, restart or not');
	assert.equal(todoReminded('t2'), true);
	assert.equal(stallReminder('t2', edit), null, 'sent back once a reply, restart or not');
	assert.equal(replyEnding('t2'), 'I’ll start with the timers.');
	assert.equal(replyMessages('t2'), 1);
	// Its round is the one it had: the same work, unchanged, is not sent back again.
	assert.equal(await completionGate('t2', edit, { chat: false, workspace: true }, deps), null);
	assert.equal(gate('t2').round?.rounds, 1);
	// Its clock runs from its own start, and remembers when it last told the time.
	assert.equal(replyElapsed('t2', t0 + 25 * 60_000), 25 * 60_000);
	assert.equal(elapsedNote('t2', t0 + 25 * 60_000), '');
	assert.match(elapsedNote('t2', t0 + 31 * 60_000), /31m since this reply started/);
});

test('a change made before the row is read is applied on the row once it is', async () => {
	say('t3', `${'The parser reads each record and keeps its offset. '.repeat(8)}`);
	say('t3', 'Next, the writer.');
	await loadGate('t3');
	await restartGates();
	// A message the resumed reply says before anything has read the row.
	say('t3', 'Done.');
	assert.equal(replyMessages('t3'), 1, 'before the row is read only the new message is known');
	await loadGate('t3');
	assert.equal(replyMessages('t3'), 3);
	assert.match(replyEnding('t3'), /keeps its offset\. [\s\S]*\n\nNext, the writer\.\n\nDone\.$/);
	assert.equal(replyEnding('t3', 2), 'Done.');
	await flushGates();
	assert.match((await getGateStateRow('t3')) ?? '', /"Done\."/);
});

test('only the messages a reply’s end is read from are kept', async () => {
	await loadGate('t4');
	say('t4', 'Let me read the entry point.');
	say('t4', `${'The first report runs long enough to be one of substance. '.repeat(6)}`);
	say('t4', 'Short line.');
	say('t4', `${'The second report replaces the first as the reply’s end. '.repeat(6)}`);
	say('t4', 'Closing line.');
	assert.equal(replyMessages('t4'), 5);
	assert.deepEqual(gate('t4').said.texts.length, 2);
	assert.match(replyEnding('t4'), /^The second report[\s\S]*\n\nClosing line\.$/);
	assert.equal(replyEnding('t4', 4), 'Closing line.');
});

test('a deleted task’s row goes with it and is never written back; an incognito chat keeps none', async () => {
	noteRequest('t5', 'Fix it.');
	await loadGate('t5');
	await flushGates();
	assert.ok(await getGateStateRow('t5'));
	await deleteSessionRecord('t5');
	assert.equal(await getGateStateRow('t5'), null);
	await saveGateStateRow('t5', '{}');
	assert.equal(await getGateStateRow('t5'), null, 'a write queued before the delete leaves nothing');
	noteRequest('inco_t6', 'Secret.');
	changeGate('inco_t6', (state) => {
		state.nudged = true;
	});
	await loadGate('inco_t6');
	await flushGates();
	assert.equal(await getGateStateRow('inco_t6'), null);
	assert.equal(requestFor('inco_t6'), 'Secret.');
});
