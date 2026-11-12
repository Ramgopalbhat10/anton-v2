import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { TextModel } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-finish-review-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { setProviders } = await import('../src/providers/index.ts');
const { findingsOf, finishReview, noteRequest, reviewPatch, selfCheck, startFinishReview } = await import('../src/services/finish-review.ts');

type Write = Parameters<TextModel['write']>[0];
let asked: Write[] = [];
let answer = 'NONE';
const writer: TextModel = {
	runs: () => true,
	write: async (input) => {
		asked.push(input);
		return { text: answer, inputTokens: 100, outputTokens: 10, cost: 0 };
	},
};
setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, text: writer });

const DIFF = 'diff --git a/src/sort.ts b/src/sort.ts\n+export function sortBy(keys: string[]) {}\n';
const deps = (patch: string | null) => ({ patch: async () => patch });
const edit = [{ tool: 'bash' }, { tool: 'edit' }];

test('a change is read against the request alone, and what it misses goes back to the agent once a reply', async () => {
	noteRequest('r', 'Add sortBy(keys) with a --reverse flag that sorts descending.');
	answer = 'I compared the two.\nMISSING: the request asks for a --reverse flag; the change adds none.\nThe sortBy function is there.';
	startFinishReview('r');
	const reminder = await finishReview('r', edit, undefined, deps(DIFF));
	assert.match(reminder ?? '', /\n\n- the request asks for a --reverse flag; the change adds none\.\n\n/);
	assert.doesNotMatch(reminder ?? '', /I compared|sortBy function is there/, 'only the MISSING lines go back');
	assert.match(reminder ?? '', /Fix those that are real/);
	assert.equal(asked.length, 1);
	assert.match(asked[0].prompt, /<request>\nAdd sortBy\(keys\) with a --reverse flag/);
	assert.match(asked[0].prompt, /export function sortBy/);
	assert.equal(asked[0].reasoning, 'off');
	// Once a reply.
	assert.equal(await finishReview('r', edit, undefined, deps(`${DIFF}+more\n`)), null);
	assert.equal(asked.length, 1);
});

test('nothing goes back when the reviewer finds nothing, the diff is empty or unchanged, or the reply waits on the user', async () => {
	asked = [];
	noteRequest('n', 'Rename the CLI flag.');
	answer = 'NONE';
	startFinishReview('n');
	assert.equal(await finishReview('n', edit, undefined, deps(DIFF)), null);
	// The same diff is not read twice, on a later reply that changed nothing.
	startFinishReview('n');
	assert.equal(await finishReview('n', edit, undefined, deps(DIFF)), null);
	assert.equal(asked.length, 1);
	startFinishReview('n');
	assert.equal(await finishReview('n', edit, undefined, deps('')), null);
	startFinishReview('n');
	assert.equal(await finishReview('n', [...edit, { tool: 'ask' }], undefined, deps(`${DIFF}+x\n`)), null);
	// A task with no request seen is never reviewed.
	startFinishReview('none');
	assert.equal(await finishReview('none', edit, undefined, deps(DIFF)), null);
	assert.equal(asked.length, 1);
});

test('a reviewer that fails leaves the reply to end as it would have', async () => {
	noteRequest('f', 'Fix it.');
	startFinishReview('f');
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, text: { runs: () => true, write: async () => Promise.reject(new Error('timeout')) } });
	assert.equal(await finishReview('f', edit, undefined, deps(DIFF)), null);
});

test('on a model no reviewer runs, such as a plan model, the agent is given the request again to check its change itself', async () => {
	asked = [];
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, text: { ...writer, runs: () => false } });
	noteRequest('p', 'Add sortBy(keys) with a --reverse flag, and fall back to insertion order on a missing key.');
	startFinishReview('p');
	const reminder = await finishReview('p', edit, undefined, deps(DIFF));
	assert.match(reminder ?? '', /<request>\nAdd sortBy\(keys\) with a --reverse flag, and fall back to insertion order on a missing key\.\n<\/request>/);
	assert.match(reminder ?? '', /error or fallback path and edge case/);
	assert.equal(asked.length, 0, 'no model call is made, so nothing is billed off the plan');
	// Once a reply, and not again for a diff it already checked.
	assert.equal(await finishReview('p', edit, undefined, deps(`${DIFF}+z\n`)), null);
	startFinishReview('p');
	assert.equal(await finishReview('p', edit, undefined, deps(DIFF)), null);
	// With no text provider at all, the same.
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, text: null });
	noteRequest('q', 'Fix it.');
	startFinishReview('q');
	assert.match((await finishReview('q', edit, undefined, deps(DIFF))) ?? '', /<request>\nFix it\.\n<\/request>/);
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, text: writer });
});

test('a chat whose reply worked in its sandbox and left no diff checks what it made against the request itself', async () => {
	asked = [];
	const chat = (patch: string | null, isChat = true) => ({ patch: async () => patch, chat: async () => isChat });
	const job = [{ tool: 'start_workspace' }, { tool: 'bash' }, { tool: 'bash' }, { tool: 'write' }, { tool: 'bash' }, { tool: 'bash' }];
	noteRequest('c', 'Write the five values to /app/results.txt, each rounded to two decimals.');
	startFinishReview('c');
	const reminder = await finishReview('c', job, undefined, chat(''));
	assert.match(reminder ?? '', /check your work against the request/);
	assert.match(reminder ?? '', /<request>\nWrite the five values to \/app\/results\.txt, each rounded to two decimals\.\n<\/request>/);
	assert.match(reminder ?? '', /each named path, file name, format, field, unit, rounding/);
	assert.match(reminder ?? '', /a caveat or a judgement call/);
	assert.equal(asked.length, 0, 'the agent makes the check itself: there is no diff for a reviewer to read');
	// Once a reply.
	assert.equal(await finishReview('c', job, undefined, chat('')), null);
	// A reply that ran a command or two answered a question; it is not sent back.
	startFinishReview('c');
	assert.equal(await finishReview('c', [{ tool: 'bash' }, { tool: 'bash' }, { tool: 'mcp__web__web_search' }, { tool: 'show' }, { tool: 'read' }, { tool: 'read' }], undefined, chat('')), null);
	// The patch profile's file changes count as work as write and edit do.
	startFinishReview('c');
	assert.match((await finishReview('c', [{ tool: 'bash' }, { tool: 'apply_patch' }, { tool: 'bash' }, { tool: 'apply_patch' }, { tool: 'bash' }], undefined, chat(''))) ?? '', /check your work against the request/);
	// Nor one that ends asking the user, nor a repository task, whose work is its diff.
	startFinishReview('c');
	assert.equal(await finishReview('c', [...job, { tool: 'ask' }], undefined, chat('')), null);
	startFinishReview('c');
	assert.equal(await finishReview('c', job, undefined, chat('', false)), null);
	startFinishReview('c');
	assert.equal(await finishReview('c', job, undefined, deps('')), null);
	// A chat that changed a repository is still reviewed on that diff.
	startFinishReview('c');
	answer = 'NONE';
	assert.equal(await finishReview('c', job, undefined, chat(DIFF)), null);
	assert.equal(asked.length, 1);
});

test('the review reads the whole change since the task began, not only what is unpushed, and not a change the reply left as it found it', async () => {
	const { readFileSync } = await import('node:fs');
	const source = readFileSync(new URL('../src/services/finish-review.ts', import.meta.url), 'utf8');
	// Once the pull request holds everything, the unpushed diff is empty: the review would read nothing.
	assert.match(source, /return \(await changesView\(id, 'branch'\)\)\.patch;/);
	asked = [];
	answer = 'NONE';
	noteRequest('b', 'Add sortBy(keys).');
	startFinishReview('b');
	assert.equal(await finishReview('b', edit, undefined, deps(DIFF)), null);
	assert.equal(asked.length, 1);
	// A later reply answers a question on the open pull request and changes nothing: the branch is not reviewed against the question.
	noteRequest('b', 'What does sortBy do with an empty list?');
	startFinishReview('b');
	assert.equal(await finishReview('b', [{ tool: 'bash' }], undefined, deps(DIFF)), null);
	assert.equal(asked.length, 1);
	// One that changes it is.
	noteRequest('b', 'Make sortBy keep the order of equal keys.');
	startFinishReview('b');
	assert.equal(await finishReview('b', edit, undefined, deps(`${DIFF}+stable\n`)), null);
	assert.equal(asked.length, 2);
	// A machine that is not running says nothing of the change, so the next reply still compares with the one last seen.
	startFinishReview('b');
	assert.equal(await finishReview('b', edit, undefined, deps(null)), null);
	startFinishReview('b');
	assert.equal(await finishReview('b', edit, undefined, deps(`${DIFF}+stable\n`)), null);
	assert.equal(asked.length, 2);
});

test('the agent’s own check asks it to settle a doubt rather than report it', () => {
	assert.match(selfCheck('Fix it.'), /settle it first from what you have/);
	assert.match(selfCheck('Fix it.'), /Read your diff \(git diff, new files included\)/);
});

test('the reviewer reads binary files as one line and a long diff cut, and NONE in any form as nothing found', () => {
	const binary = 'diff --git a/logo.png b/logo.png\nGIT binary patch\nliteral 5\nabcde\n\ndiff --git a/a.ts b/a.ts\n+x\n';
	assert.equal(reviewPatch(binary), 'diff --git a/logo.png b/logo.png\n[binary file]\ndiff --git a/a.ts b/a.ts\n+x\n');
	assert.match(reviewPatch('+'.repeat(70_000)), /The diff goes on for 10,000 more characters/);
	for (const none of ['NONE', 'None.', '**NONE**', 'none\n', '- sortBy: OK, the change does it.']) assert.equal(findingsOf(none), null, none);
	assert.equal(findingsOf('MISSING: the --reverse flag.\n**MISSING:** a default of 10.\n- MISSING: the error message'), '- the --reverse flag.\n- a default of 10.\n- the error message');
});
