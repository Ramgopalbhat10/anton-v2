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
		[pull]: { body: { state: 'open', draft: false, merged_at: null, mergeable: false, head: { sha: 'abc', ref: 'feature' }, base: { sha: 'base1', ref: 'main' } } },
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
		'/repos/acme/demo/commits/abc/status?per_page=100': {
			body: { statuses: [{ context: 'ci/circle', state: 'error', description: 'Build errored', target_url: 'u5' }] },
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
		['failed', 'skipped', 'skipped', 'passed', 'failed'],
		'commit statuses count as checks too',
	);
	assert.equal(activity.conflicts, true, 'GitHub says it cannot merge');
	assert.equal(activity.baseSha, 'base1');
});

test("someone else's pull request, open pull requests, merge bases, trees and files are read for reviews and merges", async () => {
	const pull = {
		html_url: 'https://github.com/acme/demo/pull/7',
		number: 7,
		title: 'Add things',
		body: ' Does things. ',
		user: { login: 'grace' },
		author_association: 'CONTRIBUTOR',
		state: 'open',
		draft: false,
		merged_at: null,
		updated_at: '2026-10-02T00:00:00Z',
		head: { sha: 'head1', ref: 'feature' },
		base: { sha: 'base1', ref: 'main' },
	};
	stubFetch({
		'/repos/acme/demo/pulls/7': { body: pull },
		'/repos/acme/demo/pulls/7/commits?per_page=100': { body: [{ sha: 'c1', commit: { message: 'First\n\nbody' } }, { sha: 'head1', commit: { message: 'Second' } }] },
		'/repos/acme/demo/pulls?state=open&sort=updated&direction=desc&per_page=100': { body: [{ ...pull, author_association: 'MEMBER' }] },
		'/repos/acme/demo/compare/main...head1?per_page=1': { body: { merge_base_commit: { sha: 'mb1' } } },
		'/repos/acme/demo/git/commits/head1': { body: { tree: { sha: 'tree1' } } },
		'/repos/acme/demo/git/trees/tree1?recursive=1': { body: { sha: 'tree1', truncated: false, tree: [{ path: 'src', mode: '040000', type: 'tree', sha: 't2', url: 'x' }, { path: 'src/a.ts', mode: '100644', type: 'blob', sha: 'b1', size: 3 }] } },
	});
	const host = githubHost({ token: 't', apiUrl: API });
	const info = await host.pullRequest('https://github.com/acme/demo/pull/7');
	assert.deepEqual(
		{ repo: info.repo, author: info.author, trusted: info.trusted, body: info.body, baseBranch: info.baseBranch, headSha: info.headSha, commits: info.commits },
		{ repo: 'acme/demo', author: 'grace', trusted: false, body: 'Does things.', baseBranch: 'main', headSha: 'head1', commits: [{ sha: 'c1', subject: 'First' }, { sha: 'head1', subject: 'Second' }] },
	);
	assert.equal((await host.listPullRequests('acme/demo'))[0].trusted, true, 'a member can push to the repo');
	assert.equal(await host.mergeBase('acme/demo', 'main', 'head1'), 'mb1');
	assert.deepEqual(await host.treeEntries('acme/demo', 'head1'), {
		sha: 'tree1',
		entries: [
			{ path: 'src', mode: '040000', type: 'tree', sha: 't2' },
			{ path: 'src/a.ts', mode: '100644', type: 'blob', sha: 'b1' },
		],
	});
});

test('a merged pull request is not read any further', async () => {
	const asked = stubFetch({ '/repos/acme/demo/pulls/8': { body: { state: 'closed', draft: false, merged_at: '2026-10-02T00:00:00Z', head: { sha: 'def' } } } });
	const activity = await githubHost({ token: 't', apiUrl: API }).pullRequestActivity('https://github.com/acme/demo/pull/8');
	assert.equal(activity.state, 'merged');
	assert.deepEqual(asked, ['/repos/acme/demo/pulls/8']);
});

test('a push rebuilds missing commits through the API and then moves the branch', async () => {
	const calls: string[] = [];
	const sent: Record<string, unknown> = {};
	globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
		const route = `${init.method ?? 'GET'} ${String(input).slice(API.length)}`;
		calls.push(route);
		if (init.body) sent[route] = JSON.parse(String(init.body));
		const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
		if (route === 'GET /repos/acme/demo/git/commits/aaa') return reply({ sha: 'aaa' });
		if (route === 'GET /repos/acme/demo/git/commits/bbb') return reply({ message: 'Not Found' }, 404);
		if (route === 'POST /repos/acme/demo/git/blobs') return reply({ sha: 'blob1' }, 201);
		if (route === 'POST /repos/acme/demo/git/trees') return reply({ sha: 'tree-b' }, 201);
		if (route === 'POST /repos/acme/demo/git/commits') return reply({ sha: 'bbb' }, 201);
		if (route === 'GET /repos/acme/demo/git/ref/heads/anton/fix') return reply({ message: 'Not Found' }, 404);
		if (route === 'POST /repos/acme/demo/git/refs') return reply({}, 201);
		return reply({ message: 'unexpected' }, 500);
	}) as typeof fetch;
	const read: string[] = [];
	const source = {
		async commit(sha: string) {
			read.push(sha);
			const who = { name: 'Agent', email: 'a@example.test', date: '2026-10-03T06:20:01+05:30' };
			return {
				sha,
				tree: 'tree-b',
				parents: ['aaa'],
				parentTree: 'tree-a',
				author: who,
				committer: who,
				message: 'Fix\n',
				changes: [
					{ path: 'a.txt', mode: '100644', sha: 'blob1' },
					{ path: 'gone.txt', mode: '100644', sha: null },
				],
			};
		},
		blob: async () => new TextEncoder().encode('hello\n'),
	};
	await githubHost({ token: 't', apiUrl: API }).pushCommits({ repo: 'acme/demo', branch: 'anton/fix', head: 'bbb', commits: ['aaa', 'bbb'], source });
	assert.deepEqual(read, ['bbb'], 'a commit the host has is not sent again');
	assert.deepEqual(sent['POST /repos/acme/demo/git/blobs'], { content: Buffer.from('hello\n').toString('base64'), encoding: 'base64' });
	assert.deepEqual(sent['POST /repos/acme/demo/git/trees'], {
		base_tree: 'tree-a',
		tree: [
			{ path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob1' },
			{ path: 'gone.txt', mode: '100644', type: 'blob', sha: null },
		],
	});
	assert.deepEqual(sent['POST /repos/acme/demo/git/refs'], { ref: 'refs/heads/anton/fix', sha: 'bbb' }, 'a new branch is created');

	// A host that builds a different commit (one the agent signed, say) stops the push before the branch moves.
	const wrong = { ...source, commit: async (sha: string) => ({ ...(await source.commit(sha)), sha: 'ccc' }) };
	calls.length = 0;
	await assert.rejects(
		() => githubHost({ token: 't', apiUrl: API }).pushCommits({ repo: 'acme/demo', branch: 'anton/fix', head: 'ccc', commits: ['bbb'], source: wrong }),
		/recreated commit ccc/,
	);
	assert.ok(!calls.some((call) => call.includes('/git/refs')), 'the branch is left alone');
});

test('a review that GitHub cannot place on the diff is posted with its comments in the summary', async () => {
	const bodies: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		bodies.push(body);
		return body.comments ? new Response('{"message":"Line could not be resolved"}', { status: 422 }) : new Response('{}', { status: 200 });
	}) as typeof fetch;
	await githubHost({ token: 't', apiUrl: API }).postReview('https://github.com/acme/demo/pull/7', {
		commit: 'abc',
		body: 'Summary',
		comments: [{ path: 'src/a.ts', line: 3, body: 'Off by one.\nUse <=.' }],
	});
	assert.deepEqual(bodies[0], { commit_id: 'abc', event: 'COMMENT', body: 'Summary', comments: [{ path: 'src/a.ts', line: 3, body: 'Off by one.\nUse <=.', side: 'RIGHT' }] });
	assert.deepEqual(bodies[1], { commit_id: 'abc', event: 'COMMENT', body: 'Summary\n\n- `src/a.ts:3`: Off by one. Use <=.' });
});

test('a read GitHub says is unchanged is answered from the last one, so polling costs nothing from the rate limit', async () => {
	const asked: Array<{ path: string; etag: string | null }> = [];
	let version = 1;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const etag = new Headers(init?.headers).get('if-none-match');
		asked.push({ path: String(input).slice(API.length), etag });
		if (etag === `"v${version}"`) return new Response(null, { status: 304 });
		return new Response(JSON.stringify({ full_name: 'acme/demo', default_branch: `main${version}`, private: false }), { status: 200, headers: { etag: `"v${version}"` } });
	}) as typeof fetch;
	const host = githubHost({ token: 't', apiUrl: API });
	assert.equal((await host.getRepo('acme/demo')).defaultBranch, 'main1');
	assert.equal((await host.getRepo('acme/demo')).defaultBranch, 'main1', 'a 304 gives back the saved answer');
	version = 2;
	assert.equal((await host.getRepo('acme/demo')).defaultBranch, 'main2', 'a change is read');
	assert.deepEqual(
		asked.map((ask) => ask.etag),
		[null, '"v1"', '"v1"'],
		'each read after the first asks whether it changed',
	);
});
