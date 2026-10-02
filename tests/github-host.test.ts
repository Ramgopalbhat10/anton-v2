import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubHost } from '../src/providers/github/host.ts';

const API = 'https://api.example.test';

/** Answers GitHub API paths from a table; a `next` entry adds a Link header to the following page. */
function stubFetch(pages: Record<string, { body: unknown; next?: string }>): string[] {
	const asked: string[] = [];
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		asked.push(url.slice(API.length));
		const page = pages[url.slice(API.length)];
		if (!page) return new Response('missing', { status: 404 });
		const headers = page.next ? { link: `<${API}${page.next}>; rel="next"` } : undefined;
		return new Response(JSON.stringify(page.body), { status: 200, headers });
	}) as typeof fetch;
	return asked;
}

const note = (id: number, login: string, association: string, type = 'User') => ({ id, user: { login, type }, author_association: association, body: `note ${id}`, created_at: '2026-10-02T00:00:00Z' });

test('pull request activity keeps only trusted comments, reads every page and ignores cancelled checks', async () => {
	const pull = '/repos/acme/demo/pulls/7';
	stubFetch({
		[pull]: { body: { state: 'open', draft: false, merged_at: null, head: { sha: 'abc' } } },
		'/repos/acme/demo/commits/abc/check-runs?per_page=100': {
			body: {
				check_runs: [
					{ name: 'test', status: 'completed', conclusion: 'failure', html_url: 'u1' },
					{ name: 'old', status: 'completed', conclusion: 'cancelled', html_url: 'u2' },
					{ name: 'gate', status: 'completed', conclusion: 'action_required', html_url: 'u3' },
					{ name: 'lint', status: 'completed', conclusion: 'success', html_url: 'u4' },
				],
			},
		},
		'/repos/acme/demo/issues/7/comments?per_page=100': { body: [note(1, 'owner', 'OWNER'), note(2, 'stranger', 'NONE')], next: '/repos/acme/demo/issues/7/comments?per_page=100&page=2' },
		'/repos/acme/demo/issues/7/comments?per_page=100&page=2': { body: [note(3, 'teammate', 'COLLABORATOR'), note(4, 'review-bot[bot]', 'NONE', 'Bot')] },
		[`${pull}/comments?per_page=100`]: { body: [] },
		[`${pull}/reviews?per_page=100`]: { body: [] },
	});
	const activity = await githubHost({ token: 't', apiUrl: API }).pullRequestActivity('https://github.com/acme/demo/pull/7');
	assert.deepEqual(
		activity.comments.map((comment) => comment.author),
		['owner', 'teammate', 'review-bot[bot]'],
		'a comment from someone who cannot push to the repo never reaches the agent',
	);
	assert.deepEqual(
		activity.checks.map((check) => check.status),
		['failed', 'skipped', 'skipped', 'passed'],
	);
});

test('a merged pull request is not read any further', async () => {
	const asked = stubFetch({ '/repos/acme/demo/pulls/8': { body: { state: 'closed', draft: false, merged_at: '2026-10-02T00:00:00Z', head: { sha: 'def' } } } });
	const activity = await githubHost({ token: 't', apiUrl: API }).pullRequestActivity('https://github.com/acme/demo/pull/8');
	assert.equal(activity.state, 'merged');
	assert.deepEqual(asked, ['/repos/acme/demo/pulls/8']);
});
