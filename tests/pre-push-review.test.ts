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
const { reviewerRan } = await import('../src/services/replies/reviewer-runs.ts');
const { recordSubagentEvent } = await import('../src/services/tasks/subagent-runs.ts');

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
	assert.match(asked ?? '', /Do not build a new feature, data model, approval flow, or authorization check or guard to answer a finding, whatever its severity/, 'a design question goes to the user, not into the change');
	assert.match(asked ?? '', /do not start it again/);
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

test('the reviewer subagent runs once a reply, and a reply whose agent already ran it is not asked again', async () => {
	startPrePushReview('c');
	assert.equal(reviewerRan('c'), false);
	recordSubagentEvent({ type: 'task_start', instanceId: 'c', taskId: 'task-explore', agent: 'explorer', prompt: 'Find the router' });
	assert.equal(reviewerRan('c'), false, 'other subagents do not count');
	recordSubagentEvent({ type: 'task_start', instanceId: 'c', taskId: 'task-review', agent: 'reviewer', prompt: 'Review git diff' });
	assert.equal(reviewerRan('c'), true);
	queue('c');
	assert.equal(await prePushReview('c', deps(CODE)), null);
	startPrePushReview('c');
	assert.equal(reviewerRan('c'), false, 'a new reply may have it again');
	queue('c');
	assert.equal(await prePushReview('c', deps(CODE)), null, 'the change it read counts as reviewed');
	assert.ok(await prePushReview('c', deps(`${CODE}+changed after\n`)));
});

test('reviews treat a fix that needs new design as a question for the user', async () => {
	const { REVIEW_GUIDE, REVIEW_SCOPE } = await import('../src/services/git/code-review.ts');
	assert.ok(REVIEW_GUIDE.includes(REVIEW_SCOPE), 'the pull request reviewer keeps to it too');
	assert.match(REVIEW_SCOPE, /design question for the user/);
});

test("the reviewer judges the change against the user's own request, and by the trust the code already gives", async () => {
	const { reviewerRequest } = await import('../src/agents/coder/subagents.ts');
	const { REVIEW_GUIDE, REVIEW_TRUST } = await import('../src/services/git/code-review.ts');
	const { bugReviewMessage } = await import('../src/services/replies/pre-push-review.ts');
	assert.equal(reviewerRequest(undefined), '');
	assert.equal(reviewerRequest('  '), '');
	const brief = reviewerRequest('Add a sandbox option to project to-dos.');
	assert.match(brief, /<request>\nAdd a sandbox option to project to-dos\.\n<\/request>/);
	assert.match(brief, /adds requirements the request does not make/);
	const long = reviewerRequest('x'.repeat(5_000));
	assert.ok(long.length < 3_500 && long.includes('…'), 'a long request is clipped');
	assert.ok(REVIEW_GUIDE.includes(REVIEW_TRUST), 'the pull request reviewer has the same rule');
	assert.match(REVIEW_TRUST, /already allows adds no new risk/);
	assert.match(bugReviewMessage('base0123456789abcdef', false), /a reviewer can be wrong/);
});

test('a reply answering pull request comments is left to the pull request re-review', async () => {
	const { answersPrComments, PR_COMMENTS_HEAD } = await import('../src/core/review-follow-up.ts');
	const { REVIEW_SCOPE } = await import('../src/services/git/code-review.ts');
	const comments = `${PR_COMMENTS_HEAD} (https://github.com/acme/api/pull/7):\n1. @bot on src/a.ts line 3: **Security · high**`;
	assert.ok(answersPrComments(comments));
	assert.ok(answersPrComments(`Checks failed on your pull request.\n\n${comments}`), 'after a checks or conflicts message too');
	assert.ok(!answersPrComments('Add a run-on option to to-dos'));
	assert.ok(!answersPrComments(undefined));
	startPrePushReview('c');
	queue('c');
	changeGate('c', (state) => {
		state.request = comments;
	});
	assert.equal(await prePushReview('c', deps(CODE)), null);
	changeGate('c', (state) => {
		state.request = 'Add a run-on option to to-dos';
	});
	assert.ok(await prePushReview('c', deps(CODE)), 'a reply the user asked for is still reviewed');
	assert.match(REVIEW_SCOPE, /authorization check, guard or approval step too, whatever the severity/);
});

test('answers round-trip, and the comment ids are read from the follow-up message', async () => {
	const { answerBody, answerOf, commentIdsIn } = await import('../src/core/review-follow-up.ts');
	assert.deepEqual(answerOf(answerBody('declined', ' Out of scope: the user chose it. ')), { verdict: 'declined', note: 'Out of scope: the user chose it.' });
	assert.deepEqual(answerOf(answerBody('question', 'Keep both?')), { verdict: 'question', note: 'Keep both?' });
	assert.equal(answerOf('**Fixed:** looks like one but has no mark'), null);
	const text = 'New comments on your pull request (u):\n1. [line-12] @a on x.ts: one\n2. [review-3] @a: two\n   3. [line-9] quoted, not listed';
	assert.deepEqual(commentIdsIn(text), ['line-12', 'review-3']);
	assert.deepEqual(commentIdsIn(undefined), []);
});

test('follow-up messages separate Markdown lists and indent multiline, 10+ and block-starting comments', async () => {
	const { nextFollowUp } = await import('../src/services/git/follow-ups.ts');
	const { answersPrComments, commentIdsIn } = await import('../src/core/review-follow-up.ts');
	const comments = Array.from({ length: 10 }, (_, index) => ({
		id: `line-${index + 1}`,
		author: 'reviewer',
		path: `src/f${index + 1}.ts`,
		line: index + 1,
		at: '',
		body:
			index === 0
				? '```ts\r\nconst x = 1;\r\n```'
				: index === 1
					? '- first\r\n- second'
					: index === 9
						? '\r\nFirst line\r\n\r\nSecond line\r\n'
						: `Comment ${index + 1}`,
	}));
	const activity = {
		state: 'open' as const,
		headSha: 'abc1234',
		conflicts: false,
		checks: [{ name: 'test', status: 'failed' as const, summary: '1 failed', url: 'https://ci.test/1' }],
		comments,
	};
	const { message } = nextFollowUp('https://github.com/acme/api/pull/7', activity, { sha: null, seen: [], sent: 0 });
	assert.ok(message);
	assert.doesNotMatch(message, /\r/);
	assert.ok(message.includes('Checks failed on your pull request (https://github.com/acme/api/pull/7) at abc1234:\n\n- test: 1 failed (https://ci.test/1)\n\nFind the cause'));
	assert.ok(message.includes('New comments on your pull request (https://github.com/acme/api/pull/7):\n\n1. [line-1] @reviewer on src/f1.ts line 1:\n   ```ts\n   const x = 1;\n   ```'));
	assert.ok(message.includes('2. [line-2] @reviewer on src/f2.ts line 2:\n   - first\n   - second'));
	assert.ok(message.includes('10. [line-10] @reviewer on src/f10.ts line 10: First line\n\n    Second line\n\nFor each one, first check'));
	assert.ok(answersPrComments(message));
	assert.deepEqual(
		commentIdsIn(message),
		comments.map((comment) => comment.id),
	);
});
