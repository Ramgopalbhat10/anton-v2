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
const { findingsOf, finishReview, isRequest, MAX_REVIEWS, noteRequest, requestFor, reopenFinishReview, reviewPatch, reviewPrompt, selfCheck, startFinishReview } = await import('../src/services/finish-review.ts');

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

test('a change is read against the request alone, and what it misses goes back to the agent', async () => {
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
	// The same change is not read again in the reply.
	assert.equal(await finishReview('r', edit, undefined, deps(DIFF)), null);
	assert.equal(asked.length, 1);
	// What the agent changes after it is sent back is read once more; past that the reply ends without another review.
	assert.match((await finishReview('r', edit, undefined, deps(`${DIFF}+more\n`))) ?? '', /--reverse flag/);
	assert.equal(asked.length, MAX_REVIEWS);
	assert.equal(await finishReview('r', edit, undefined, deps(`${DIFF}+more\n+again\n`)), null);
	assert.equal(asked.length, MAX_REVIEWS);
});

test('a reply that changes code after a review sent it back, then a reply that changes nothing: the second is not reviewed', async () => {
	asked = [];
	noteRequest('s', 'Add sortBy(keys) with a --reverse flag.');
	answer = 'MISSING: the --reverse flag.';
	startFinishReview('s');
	assert.ok(await finishReview('s', edit, undefined, deps(DIFF)));
	// The agent fixes it; the review reads the new change and finds nothing.
	answer = 'NONE';
	const fixed = `${DIFF}+export const reverse = true;\n`;
	assert.equal(await finishReview('s', edit, undefined, deps(fixed)), null);
	assert.equal(asked.length, 2);
	// A question answered on the next reply leaves the change as the last reply left it.
	noteRequest('s', 'Does sortBy keep equal keys in order?');
	startFinishReview('s');
	assert.equal(await finishReview('s', [{ tool: 'bash' }], undefined, deps(fixed)), null);
	assert.equal(asked.length, 2);
});

test('the request is the message that started the reply, not one that joined it', () => {
	noteRequest('j', '  Fix incognito chat scrolling.  ');
	assert.equal(isRequest('j', 'Fix incognito chat scrolling.'), true);
	// A message sent while the reply runs is answered within it; the checks at its end still read the request.
	assert.equal(isRequest('j', 'What are you even testing? Are you stuck?'), false);
	assert.equal(requestFor('j'), 'Fix incognito chat scrolling.');
});

test('a reply that reached its bound still leaves its change as seen, so the next reply that changes nothing is not reviewed', async () => {
	asked = [];
	noteRequest('u', 'Add sortBy(keys) with a --reverse flag.');
	answer = 'MISSING: the --reverse flag.';
	startFinishReview('u');
	let diff = DIFF;
	for (let review = 1; review <= MAX_REVIEWS; review += 1) {
		assert.ok(await finishReview('u', edit, undefined, deps(diff)));
		diff += `+change ${review}\n`;
	}
	// The bound is reached: the last change is read, not reviewed.
	assert.equal(await finishReview('u', edit, undefined, deps(diff)), null);
	assert.equal(asked.length, MAX_REVIEWS);
	noteRequest('u', 'What does sortBy return for an empty list?');
	startFinishReview('u');
	assert.equal(await finishReview('u', [{ tool: 'bash' }], undefined, deps(diff)), null);
	assert.equal(asked.length, MAX_REVIEWS);
});

test('a reply with no diff spends no review, and the completion gate lets one more change be read past the bound', async () => {
	asked = [];
	noteRequest('v', 'Add sortBy(keys).');
	answer = 'MISSING: the keys argument.';
	startFinishReview('v');
	assert.equal(await finishReview('v', edit, undefined, deps('')), null);
	assert.equal(await finishReview('v', edit, undefined, deps(null)), null);
	assert.equal(asked.length, 0);
	let diff = DIFF;
	for (let review = 1; review <= MAX_REVIEWS; review += 1) {
		assert.ok(await finishReview('v', edit, undefined, deps(diff)));
		diff += `+change ${review}\n`;
	}
	assert.equal(await finishReview('v', edit, undefined, deps(diff)), null);
	// Sent back by the completion gate: the change it then makes is read, once.
	reopenFinishReview('v');
	diff += '+after the gate\n';
	assert.ok(await finishReview('v', edit, undefined, deps(diff)));
	diff += '+more\n';
	assert.equal(await finishReview('v', edit, undefined, deps(diff)), null);
	assert.equal(asked.length, MAX_REVIEWS + 1);
});

test('the same request and change are never reviewed twice, across replies', async () => {
	asked = [];
	answer = 'NONE';
	noteRequest('w', 'Add sortBy(keys).');
	startFinishReview('w');
	assert.equal(await finishReview('w', edit, undefined, deps(DIFF)), null);
	startFinishReview('w');
	assert.equal(await finishReview('w', edit, undefined, deps(`${DIFF}+b\n`)), null);
	// The agent puts the change back as it was: reviewed once already for this request.
	startFinishReview('w');
	assert.equal(await finishReview('w', edit, undefined, deps(DIFF)), null);
	assert.equal(asked.length, 2);
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

/** A file's diff of `hunks` hunks of `lines` added lines each. */
const fileDiff = (file: string, hunks: number, lines: number, mark = '') =>
	`diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n` +
	Array.from({ length: hunks }, (_, hunk) => `@@ -${hunk * 100 + 1},2 +${hunk * 100 + 1},${lines + 2} @@ hunk ${hunk + 1}${mark}\n context\n${Array.from({ length: lines }, (_, line) => `+${file} line ${line} of hunk ${hunk + 1}${mark}\n`).join('')}-old line\n`).join('');

test('a diff within the limit reaches the reviewer exactly as it is', () => {
	const files = Array.from({ length: 12 }, (_, index) => fileDiff(`src/f${index}.ts`, 3, 40)).join('');
	const patch = files;
	assert.ok(patch.length > 40_000 && patch.length <= 60_000, `${patch.length}`);
	assert.ok(reviewPatch(patch) === patch);
	assert.ok(reviewPatch(patch, () => false) === patch, 'which files the reply changed makes no difference within the limit');
	const prompt = reviewPrompt('Fix it.', reviewPatch(patch));
	assert.ok(prompt.includes(`<diff>\n${patch}\n</diff>`));
});

test('past the limit, every file is named, the reply’s own files are read first and lock files last, and nothing named is unseen', () => {
	const files = [
		fileDiff('package-lock.json', 1, 1_500),
		fileDiff('src/big.ts', 12, 120),
		...Array.from({ length: 30 }, (_, index) => fileDiff(`src/old${index}.ts`, 2, 30)),
		fileDiff('assets/logo.png', 0, 0).replace(/index[^\n]*\n--- [^\n]*\n\+\+\+ [^\n]*\n/, 'GIT binary patch\nliteral 5\nabcde\n\n'),
		fileDiff('src/late.ts', 2, 10),
	];
	const patch = files.join('');
	assert.ok(patch.length > 150_000);
	const mine = new Set(['src/late.ts', 'package-lock.json', 'src/big.ts']);
	const view = reviewPatch(patch, (file) => mine.has(file));
	assert.ok(view.length <= 61_000, `${view.length}`);
	assert.match(view, /^\[This diff runs to [\d,]+ characters, more than is read whole\./);
	const list = view.slice(0, view.indexOf('\ndiff --git '));
	for (const name of ['package-lock.json', 'src/big.ts', 'src/old0.ts', 'src/old29.ts', 'assets/logo.png', 'src/late.ts']) assert.ok(list.includes(`\n${name} `), name);
	assert.match(list, /\nsrc\/late\.ts \+20 -2\n/);
	assert.match(list, /\nassets\/logo\.png binary\n/);
	// The reply's own files come first, a person's before the lock file; the rest after.
	const at = (name: string) => view.indexOf(`diff --git a/${name} `);
	assert.ok(at('src/big.ts') < at('src/late.ts') && at('src/late.ts') < at('package-lock.json'), 'the reply’s own files, in the diff’s order, with the lock file last');
	assert.ok(at('src/late.ts') > 0 && at('src/late.ts') < at('src/old0.ts'));
	assert.ok(view.includes('+src/late.ts line 9 of hunk 2\n'), 'a small file of the reply’s is read whole');
	// A long file keeps its first hunks and its last, and says what was left out.
	const big = view.slice(at('src/big.ts'), at('src/late.ts'));
	assert.match(big, /@@ -1,2 \+1,122 @@ hunk 1\n/);
	assert.match(big, /@@ -1101,2 \+1101,122 @@ hunk 12\n/);
	assert.match(big, /\n\[[\d,]+ lines of this file's diff left out\]\n/);
	assert.doesNotMatch(big, /hunk 6\n/);
	// What did not fit is named at the end.
	const closing = view.slice(view.lastIndexOf('\n') + 1);
	assert.match(closing, /^\[Diffs left out for room, of files listed above: .*src\/old29\.ts.*\.\]$/);
	for (const name of ['src/big.ts', 'src/late.ts']) assert.ok(!closing.includes(name), name);
});

test('a new file too long for its share is read from its start and its end', () => {
	const patch = fileDiff('src/new.ts', 1, 3_000) + fileDiff('src/other.ts', 1, 3_000);
	const view = reviewPatch(patch);
	assert.ok(view.length <= 61_000, `${view.length}`);
	assert.ok(view.includes('+src/new.ts line 0 of hunk 1\n'));
	assert.ok(view.includes('+src/new.ts line 2999 of hunk 1\n-old line\n'));
	assert.ok(view.includes('+src/other.ts line 0 of hunk 1\n'));
	assert.match(view, /lines of this file's diff left out/);
});

test('on a later reply of a large branch, the files that reply changed are the ones read first', async () => {
	asked = [];
	answer = 'NONE';
	const old = Array.from({ length: 40 }, (_, index) => fileDiff(`src/old${index}.ts`, 2, 40)).join('');
	noteRequest('l', 'Add the export command.');
	startFinishReview('l');
	assert.equal(await finishReview('l', edit, undefined, deps(old + fileDiff('src/z-export.ts', 1, 5))), null);
	// On the next reply the agent changes only the file at the end of the branch's diff.
	noteRequest('l', 'Make the export command take --format.');
	startFinishReview('l');
	assert.equal(await finishReview('l', edit, undefined, deps(old + fileDiff('src/z-export.ts', 1, 6, ' format'))), null);
	assert.equal(asked.length, 2);
	const first = asked[0].prompt;
	const second = asked[1].prompt;
	assert.ok(first.indexOf('diff --git a/src/z-export.ts ') > first.indexOf('diff --git a/src/old0.ts '), 'on its first reply the task’s files are read in the diff’s order');
	const at = second.indexOf('diff --git a/src/z-export.ts ');
	assert.ok(at > 0 && at < second.indexOf('diff --git a/src/old0.ts '));
	assert.ok(second.includes('+src/z-export.ts line 5 of hunk 1 format\n'));
});

test('the reviewer judges only what a diff can show, and a reasonable reading of the request', async () => {
	const { reviewPrompt } = await import('../src/services/finish-review.ts');
	const prompt = reviewPrompt('Run the whole suite and report which tests fail.', 'diff --git a/x b/x');
	assert.match(prompt, /Judge only what a diff can show\. A request to run commands or tests, report results, explain or answer something is not missing from the change\./);
	assert.match(prompt, /follows a reasonable reading, it is not missing/);
});
