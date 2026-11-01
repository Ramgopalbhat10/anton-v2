import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-finish-review-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { changedLines, finishReview, noteRequest, requestFor, startFinishReview, verifierPrompt } = await import('../src/services/finish-review.ts');

/** A diff of `n` added lines, past the size a verifier is asked for. */
const diff = (n = 25, tag = 'a') => `diff --git a/src/sort.ts b/src/sort.ts\n--- a/src/sort.ts\n+++ b/src/sort.ts\n${Array.from({ length: n }, (_, i) => `+const ${tag}${i} = ${i};`).join('\n')}\n`;
const deps = (patch: string | null) => ({ patch: async () => patch });
const edit = [{ tool: 'bash' }, { tool: 'edit' }];

test('a change is sent to the verifier, and once more after the agent changes it, at most twice a reply', async () => {
	noteRequest('r', 'Add sortBy(keys) with a --reverse flag that sorts descending.');
	startFinishReview('r');
	const first = await finishReview('r', edit, undefined, deps(diff()));
	assert.match(first ?? '', /call the verifier subagent/);
	assert.match(first ?? '', /fix each FAIL it reports that is real/);
	// Ending again with the same diff: the verifier found nothing to fix.
	assert.equal(await finishReview('r', edit, undefined, deps(diff())), null);
	// The agent fixed something after the report: verified once more.
	assert.match((await finishReview('r', edit, undefined, deps(diff(25, 'b')))) ?? '', /Call the verifier once more/);
	// Never a third time in one reply.
	assert.equal(await finishReview('r', edit, undefined, deps(diff(25, 'c'))), null);
	// A new reply that changed the code is verified again.
	startFinishReview('r');
	assert.match((await finishReview('r', edit, undefined, deps(diff(25, 'd')))) ?? '', /call the verifier subagent/);
});

test('nothing goes back for a small change, an empty or already verified diff, a reply that waits on the user, or a task with no request', async () => {
	noteRequest('n', 'Rename the CLI flag.');
	startFinishReview('n');
	assert.equal(await finishReview('n', edit, undefined, deps(diff(5))), null, 'a one-line fix needs no second agent');
	assert.equal(await finishReview('n', edit, undefined, deps('')), null);
	assert.equal(await finishReview('n', edit, undefined, deps(null)), null);
	assert.equal(await finishReview('n', [...edit, { tool: 'ask' }], undefined, deps(diff())), null);
	assert.equal(await finishReview('n', [...edit, { tool: 'propose_plan' }], undefined, deps(diff())), null);
	assert.ok(await finishReview('n', edit, undefined, deps(diff())));
	// The same diff on a later reply that changed nothing is not verified again.
	startFinishReview('n');
	assert.equal(await finishReview('n', edit, undefined, deps(diff())), null);
	startFinishReview('none');
	assert.equal(await finishReview('none', edit, undefined, deps(diff())), null);
});

test('a diff that cannot be read leaves the reply to end as it would have', async () => {
	noteRequest('f', 'Fix it.');
	startFinishReview('f');
	assert.equal(await finishReview('f', edit, undefined, { patch: async () => Promise.reject(new Error('machine gone')) }), null);
});

test('the verifier reads the request whole and is told to run each behaviour, change nothing and report a verdict', () => {
	noteRequest('v', 'Add sortBy(keys) with a --reverse flag, and fall back to insertion order on a missing key.');
	const prompt = verifierPrompt(requestFor('v'));
	assert.match(prompt, /<request>\nAdd sortBy\(keys\) with a --reverse flag, and fall back to insertion order on a missing key\.\n<\/request>/);
	assert.match(prompt, /error and fallback path, edge case and end state/);
	assert.match(prompt, /the way it will be used/);
	assert.match(prompt, /Change, stage and commit nothing/);
	assert.match(prompt, /VERDICT: PASS/);
	assert.match(verifierPrompt(null), /take it from your brief/);
});

test('changed lines count what a diff adds and removes, not its file headers', () => {
	assert.equal(changedLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context\n'), 2);
	assert.equal(changedLines(''), 0);
});
