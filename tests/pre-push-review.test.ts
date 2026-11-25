import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-pre-push-review-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { changeGate } = await import('../src/services/replies/gate-state.ts');
const { prePushReview, startPrePushReview } = await import('../src/services/replies/pre-push-review.ts');

const CODE = 'diff --git a/src/sort.ts b/src/sort.ts\n+export function sortBy(keys: string[]) {}\n';
const DOCS = 'diff --git a/docs/sorting.md b/docs/sorting.md\n+Sorting\ndiff --git a/README.md b/README.md\n+More\n';
let reviews = true;
const deps = (patch: string | null, from = 'base0123456789abcdef', pushed = false) => ({
	change: async () => (patch === null ? null : { patch, from, pushed }),
	reviews: async () => reviews,
});
const queue = (id: string) =>
	changeGate(id, (state) => {
		state.pullRequest = { title: 'Sort', body: '' };
	});

test('a reply about to push a code change is asked once for a fresh-eyes review of it', async () => {
	startPrePushReview('a');
	assert.equal(await prePushReview('a', deps(CODE)), null, 'nothing is pushed, so nothing is asked');
	queue('a');
	const asked = await prePushReview('a', deps(CODE));
	assert.match(asked ?? '', /reviewer subagent/);
	assert.match(asked ?? '', /`git diff base01234567`/, 'the brief names the range to read');
	assert.match(asked ?? '', /critical, high or medium/);
	assert.doesNotMatch(asked ?? '', /since your last push/);
	assert.match(asked ?? '', /If you cannot start the subagent/, 'a runtime without subagents reviews it itself');
	assert.equal(await prePushReview('a', deps(`${CODE}+fixed\n`)), null, 'once a reply, so its fixes are not reviewed again before the push');

	startPrePushReview('a');
	queue('a');
	assert.equal(await prePushReview('a', deps(`${CODE}+fixed\n`)), null, 'a change already reviewed is not asked for again');
	const later = await prePushReview('a', deps(`${CODE}+fixed\n+after review comments\n`, 'pushed0123456789', true));
	assert.match(later ?? '', /`git diff pushed012345` in the repository \(what changed since your last push\)/, 'after a push only what came since is read');
});

test('documentation, a stopped machine and reviews turned off are never held for it', async () => {
	startPrePushReview('b');
	queue('b');
	assert.equal(await prePushReview('b', deps(DOCS)), null);
	assert.equal(await prePushReview('b', deps(null)), null);
	assert.equal(await prePushReview('b', deps('  \n')), null);
	reviews = false;
	assert.equal(await prePushReview('b', deps(CODE)), null);
	reviews = true;
	assert.ok(await prePushReview('b', deps(CODE)));
});
