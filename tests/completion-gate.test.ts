import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { DecisionModel } from '../src/core/ports.ts';
import type { TodoList } from '../src/services/todos.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-completion-gate-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { setProviders } = await import('../src/providers/index.ts');
const { carryOn, completionGate, MAX_ROUNDS, startCompletionGate, undoneByRule } = await import('../src/services/completion-gate.ts');
const { finishReview, noteRequest, startFinishReview } = await import('../src/services/finish-review.ts');
const { checkReply, recordReplyText } = await import('../src/services/reply-check.ts');

const providers = (decisions: DecisionModel | null) =>
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'x', list: async () => [] }, text: null, decisions });

const HOUR = 3_600_000;
const list = (...steps: Array<[string, 'pending' | 'in_progress' | 'completed']>): TodoList => ({ todos: steps.map(([content, status]) => ({ content, status })), updatedAt: '2026-11-11T00:00:00Z' });
const repo = { chat: false, workspace: true };

/** The pebble run: a todo list written with its steps open, a few commands, no diff, and a last message that says the work is not done. */
const PEBBLE_END =
	'The requested implementation is not complete. No source files were changed, no tests were run, and no commit was made. The wait APIs need durable timers, which is a larger change than fits here.';
const pebbleCalls = [{ tool: 'update_todos' }, { tool: 'bash' }, { tool: 'bash' }, { tool: 'bash' }, { tool: 'update_todos' }];
const pebble = (patch: () => string | null = () => '') => ({
	ending: () => PEBBLE_END,
	todos: async () => list(['Add wait_for_event', 'in_progress'], ['Add durable timers', 'pending'], ['Read the code', 'completed']),
	patch: async () => patch(),
	reminded: () => true,
	request: () => 'Add durable wait APIs: wait_for_event and wait_until, persisted across restarts.',
	elapsed: () => 6 * 60_000,
	limitMs: 4 * HOUR,
});

test('the pebble case: a repository reply with open steps, commands run and no diff, that says the work is not done, is sent back', async () => {
	providers(null);
	startCompletionGate('pebble');
	const back = await completionGate('pebble', pebbleCalls, repo, pebble());
	assert.equal(
		back,
		'Your reply ended with work the request asked for not done (your todo list has 2 steps open). This reply has run 6m of the 4 hours it may run, so there is time to do it in full. ' +
			'Carry on and do the work now, starting with the smallest piece that works, and check each piece as you go. ' +
			'End your reply only when the request is done, or when what remains needs something only the user can give; then name exactly what that is.',
	);
});

test('rounds are bounded, and after the first only a round that changed the diff is followed by another', async () => {
	providers(null);
	let diff = '';
	const deps = pebble(() => diff);
	startCompletionGate('rounds');
	assert.ok(await completionGate('rounds', pebbleCalls, repo, deps));
	// It said the same again and changed nothing: it is let go rather than held in a loop.
	assert.equal(await completionGate('rounds', pebbleCalls, repo, deps), null);
	startCompletionGate('rounds');
	for (let round = 1; round <= MAX_ROUNDS; round += 1) {
		diff += `diff --git a/x b/x\n+line ${round}\n`;
		assert.ok(await completionGate('rounds', pebbleCalls, repo, deps), `round ${round}`);
	}
	diff += '+more\n';
	assert.equal(await completionGate('rounds', pebbleCalls, repo, deps), null, 'never past the bound');
	// A new reply starts again.
	startCompletionGate('rounds');
	assert.ok(await completionGate('rounds', pebbleCalls, repo, deps));
});

test('a chat in its sandbox counts its sandbox work as progress, as it has no diff', async () => {
	providers(null);
	const deps = { ...pebble(), patch: async () => Promise.reject(new Error('a chat’s diff is not read')) };
	const chat = { chat: true, workspace: true };
	startCompletionGate('chat');
	assert.ok(await completionGate('chat', pebbleCalls, chat, deps));
	assert.equal(await completionGate('chat', pebbleCalls, chat, deps), null);
	assert.ok(await completionGate('chat', [...pebbleCalls, { tool: 'write' }], chat, deps));
	assert.ok(await completionGate('chat', [...pebbleCalls, { tool: 'write' }, { tool: 'apply_patch' }], chat, deps));
});

test('never on a reply that asks, proposes a plan, is aborted, or is a chat with no sandbox or an incognito one', async () => {
	providers(null);
	const deps = pebble();
	for (const [id, calls, context] of [
		['g1', [...pebbleCalls, { tool: 'ask' }], repo],
		['g2', [...pebbleCalls, { tool: 'propose_plan' }], repo],
		['g3', pebbleCalls, { chat: true, workspace: false }],
		['inco_g4', pebbleCalls, { chat: true, workspace: true }],
		['g5', pebbleCalls, { ...repo, signal: AbortSignal.abort() }],
	] as const) {
		startCompletionGate(id);
		assert.equal(await completionGate(id, calls, context, deps), null, id);
	}
});

test('without a decision model, the plain rule reads the last words and the list left open after its reminder', () => {
	// Declared incomplete, after work.
	assert.ok(undoneByRule(PEBBLE_END, 0, false, true));
	assert.ok(undoneByRule('The fresh check confirms the commit changes only dependency declarations. The requested `mode` parameter is still unimplemented.', 0, false, true));
	assert.ok(undoneByRule('I was unable to complete the spilling to disk.', 0, false, true));
	// A list left open after the reminder, with no reason the user can act on.
	assert.ok(undoneByRule('Progress so far: the parser is in.', 2, true, true));
	assert.equal(undoneByRule('Progress so far: the parser is in.', 2, false, true), false, 'not before the reminder has had its say');
	// Finished work, and ordinary words that only look alike.
	for (const done of ['Done: the tests pass and the pull request is open.', 'The pull request remains open for review.', 'Fixed the incomplete error handling in parse().']) {
		assert.equal(undoneByRule(done, 0, true, true), false, done);
	}
	// A stop for something only the user can give, or a question.
	assert.equal(undoneByRule('The deploy step is not complete: it needs your API key for the registry.', 1, true, true), false);
	assert.equal(undoneByRule('The migration is not complete. Should I run it against production?', 1, true, true), false);
	// A reply that only read and answered may say what code does not do.
	assert.equal(undoneByRule('Refresh tokens are not implemented in this codebase.', 0, false, false), false);
});

test('a chat or a reply that only answered a question is not sent back, nor one with nothing to judge', async () => {
	providers(null);
	const answer = { ...pebble(), ending: () => 'Refresh tokens are not implemented in this codebase; sessions last a day.', todos: async () => null };
	startCompletionGate('q');
	assert.equal(await completionGate('q', [{ tool: 'read_file' }, { tool: 'search_code' }], { chat: false, workspace: false }, answer), null);
	startCompletionGate('q');
	assert.equal(await completionGate('q', [{ tool: 'bash' }], repo, { ...answer, ending: () => '' }), null);
});

test('with a decision model, it judges the reply’s end, the request and the open steps, and its no stands', async () => {
	const asked: Array<Record<string, unknown>> = [];
	let yes = 0.9;
	providers({
		name: 'jev',
		async decide(state, questions) {
			asked.push(state);
			assert.match(questions.undone.instructions, /for a reason other than needing the user to decide, provide or do something/);
			return { answers: { undone: { yes } }, inputTokens: 10, cost: 0 };
		},
	});
	startCompletionGate('m');
	assert.ok(await completionGate('m', pebbleCalls, repo, pebble()));
	assert.match(String(asked[0].request), /durable wait APIs/);
	assert.match(String(asked[0].reply), /not complete/);
	assert.equal(asked[0].openTodoSteps, 'Add wait_for_event\nAdd durable timers');
	// The model reads more than the words: a give-up the plain rule would miss is sent back, and a no is not overruled by the rule.
	startCompletionGate('m2');
	assert.ok(await completionGate('m2', pebbleCalls, repo, { ...pebble(), ending: () => 'I added the scaffolding; the rest can come in a follow-up.' }));
	yes = 0.1;
	startCompletionGate('m3');
	assert.equal(await completionGate('m3', pebbleCalls, repo, pebble()), null);
	// A model that fails leaves the plain rule to judge.
	providers({ name: 'jev', decide: async () => Promise.reject(new Error('down')) });
	startCompletionGate('m4');
	assert.ok(await completionGate('m4', pebbleCalls, repo, pebble()));
});

test('after a send-back, the finish review reads the new change in the same reply, once', async () => {
	providers(null);
	let diff = '';
	const patch = { patch: async () => diff };
	const edit = [{ tool: 'bash' }, { tool: 'edit' }];
	noteRequest('fr', 'Add durable wait APIs.');
	startFinishReview('fr');
	startCompletionGate('fr');
	// No diff: nothing to review, and the gate sends the reply back.
	assert.equal(await finishReview('fr', edit, undefined, patch), null);
	assert.ok(await completionGate('fr', pebbleCalls, repo, { ...pebble(() => diff) }));
	// The agent made the change; the review (here the agent's own check, as no reviewer runs) reads it.
	diff = 'diff --git a/wait.ts b/wait.ts\n+export function waitUntil() {}\n';
	assert.match((await finishReview('fr', edit, undefined, patch)) ?? '', /check your change against the request/);
	assert.equal(await finishReview('fr', edit, undefined, patch), null, 'once for that change');
});

test('after a send-back, only what the reply said since is judged, so a short closing line is not read with the stale one', async () => {
	providers(null);
	const say = (text: string) => recordReplyText({ type: 'message_end', instanceId: 'stale', session: 'default', message: { role: 'assistant', content: text } });
	let diff = '';
	let todos = list(['Add wait_for_event', 'in_progress'], ['Add durable timers', 'pending']);
	// The reply's end is read from its messages as the runtime reports them; only the rest is faked.
	const { ending: _ending, ...rest } = pebble(() => diff);
	const deps = { ...rest, todos: async () => todos };
	startCompletionGate('stale');
	// A message of substance that says the work is not done: sent back.
	say(`${PEBBLE_END} ${'The timers need a table and a sweeper. '.repeat(6)}`);
	assert.ok(await completionGate('stale', pebbleCalls, repo, deps));
	// The agent does the work and closes with one short line; read with the message before the send-back, it would go back again.
	diff = 'diff --git a/wait.ts b/wait.ts\n+export function waitUntil() {}\n';
	todos = list(['Add wait_for_event', 'completed'], ['Add durable timers', 'completed']);
	say('Done; all steps are complete.');
	assert.equal(await completionGate('stale', [...pebbleCalls, { tool: 'edit' }], repo, deps), null);
	// What it says after the send-back still counts: a new admission is sent back.
	diff += '+more\n';
	say('The durable timers are still unimplemented.');
	assert.ok(await completionGate('stale', [...pebbleCalls, { tool: 'edit' }], repo, deps));
	await checkReply('stale').catch(() => undefined);
});

test('the message names the limit when the reply’s start is not known', () => {
	assert.match(carryOn(null, 4 * HOUR, 0), /^Your reply ended with work the request asked for not done\. A reply may run for up to 4 hours, so there is time/);
	assert.match(carryOn(85 * 60_000, 8 * HOUR, 1), /\(your todo list has 1 step open\)\. This reply has run 1h 25m of the 8 hours it may run/);
});

test('a reply the finish review sent back is judged with the reviewer’s points and what it reported before them', async () => {
	const asked: Array<{ state: Record<string, unknown>; instructions: string }> = [];
	providers({
		name: 'jev',
		async decide(state, questions) {
			asked.push({ state, instructions: questions.undone.instructions });
			return { answers: { undone: { yes: 0.1 } }, inputTokens: 10, cost: 0 };
		},
	});
	const reviewed = { points: '- clockTime should return 07:05 for 7:05.', before: 'All three changes are in place: clockTime, zoneName and describeSchedule, each with a test.' };
	startCompletionGate('rv');
	const ending = () => "The reviewer's point is wrong: the request asks for the same output the padded input gets, which is what the change does.";
	assert.equal(await completionGate('rv', pebbleCalls, repo, { ...pebble(), ending, reviewed: () => reviewed }), null);
	assert.equal(asked[0].state.reviewerPoints, reviewed.points);
	assert.equal(asked[0].state.replyBeforeReview, reviewed.before);
	assert.match(asked[0].instructions, /explaining why a point is wrong or not asked for, is not work left undone/);
	// With no review behind it, the question is as it was.
	startCompletionGate('rv2');
	await completionGate('rv2', pebbleCalls, repo, { ...pebble(), reviewed: () => null });
	assert.equal(asked[1].state.reviewerPoints, undefined);
	assert.doesNotMatch(asked[1].instructions, /reviewerPoints/);
});
