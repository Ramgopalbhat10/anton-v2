import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	exchangeCode,
	fetchRepo,
	fetchUser,
	githubAuthorizeUrl,
	listRepos,
	openPullRequest,
	refreshAccessToken,
} from '../src/lib/github.ts';

const client = { clientId: 'cid', clientSecret: 'csec', callbackUrl: 'http://127.0.0.1:43127/api/auth/github/callback' };

test('githubAuthorizeUrl requests repo, user, and email scopes', () => {
	const url = new URL(githubAuthorizeUrl('state-1', client));
	assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
	assert.equal(url.searchParams.get('client_id'), 'cid');
	assert.equal(url.searchParams.get('redirect_uri'), client.callbackUrl);
	assert.equal(url.searchParams.get('state'), 'state-1');
	assert.equal(url.searchParams.get('scope'), 'read:user user:email repo');
});

test('exchangeCode returns the access token and optional refresh token', async () => {
	const fetchImpl: typeof fetch = async (input, init) => {
		assert.equal(String(input), 'https://github.com/login/oauth/access_token');
		const body = JSON.parse(String(init?.body));
		assert.equal(body.client_id, 'cid');
		assert.equal(body.code, 'abc');
		assert.equal(body.redirect_uri, client.callbackUrl);
		return json({
			access_token: 'gho_access',
			refresh_token: 'ghr_refresh',
			expires_in: 28800,
			token_type: 'bearer',
		});
	};
	const now = Date.parse('2026-09-30T00:00:00.000Z');
	const token = await exchangeCode('abc', client, fetchImpl, now);
	assert.equal(token.accessToken, 'gho_access');
	assert.equal(token.refreshToken, 'ghr_refresh');
	assert.equal(token.expiresAt, new Date(now + 28800 * 1000).toISOString());
});

test('exchangeCode throws the GitHub error description', async () => {
	const fetchImpl: typeof fetch = async () => json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect.' });
	await assert.rejects(() => exchangeCode('nope', client, fetchImpl), /incorrect/);
});

test('fetchUser uses the primary verified email when the profile email is empty', async () => {
	const fetchImpl: typeof fetch = async (input, init) => {
		assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gho_access');
		const url = String(input);
		if (url.endsWith('/user')) {
			return json({ id: 7, login: 'octocat', avatar_url: 'https://example.test/a.png', name: 'Mona', email: null });
		}
		assert.equal(url, 'https://api.github.com/user/emails');
		return json([
			{ email: 'other@example.test', primary: false, verified: true },
			{ email: 'mona@example.test', primary: true, verified: true },
		]);
	};
	const user = await fetchUser('gho_access', fetchImpl);
	assert.deepEqual(user, {
		id: 7,
		login: 'octocat',
		avatarUrl: 'https://example.test/a.png',
		name: 'Mona',
		email: 'mona@example.test',
	});
});

test('listRepos keeps repositories the user can push and follows the next page', async () => {
	const fetchImpl: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes('page=2')) {
			return json([
				{ full_name: 'octocat/private', default_branch: 'main', private: true, permissions: { push: true } },
			]);
		}
		return new Response(
			JSON.stringify([
				{ full_name: 'octocat/read-only', default_branch: 'main', private: false, permissions: { push: false } },
				{ full_name: 'octocat/app', default_branch: 'develop', private: false, permissions: { push: true } },
			]),
			{ status: 200, headers: { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' } },
		);
	};
	const repos = await listRepos('gho_access', fetchImpl);
	assert.deepEqual(
		repos.map((repo) => repo.fullName),
		['octocat/app', 'octocat/private'],
	);
	assert.equal(repos[0]?.defaultBranch, 'develop');
});

test('fetchRepo rejects a repository without push access', async () => {
	const fetchImpl: typeof fetch = async () =>
		json({ full_name: 'octocat/read-only', default_branch: 'main', private: false, permissions: { push: false } });
	await assert.rejects(() => fetchRepo('gho_access', 'octocat/read-only', fetchImpl), /push/);
});

test('openPullRequest posts the branch against the default branch', async () => {
	const fetchImpl: typeof fetch = async (input, init) => {
		assert.equal(String(input), 'https://api.github.com/repos/octocat/app/pulls');
		assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gho_access');
		assert.deepEqual(JSON.parse(String(init?.body)), {
			title: 'feat: anton',
			head: 'anton/abcd',
			base: 'main',
			body: 'Opened by Anton.',
		});
		return json({ html_url: 'https://github.com/octocat/app/pull/3', number: 3 });
	};
	const pr = await openPullRequest(
		{
			token: 'gho_access',
			repoFullName: 'octocat/app',
			title: 'feat: anton',
			head: 'anton/abcd',
			base: 'main',
			body: 'Opened by Anton.',
		},
		fetchImpl,
	);
	assert.equal(pr.url, 'https://github.com/octocat/app/pull/3');
});

test('refreshAccessToken exchanges a refresh token', async () => {
	const fetchImpl: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		assert.equal(body.grant_type, 'refresh_token');
		assert.equal(body.refresh_token, 'ghr_refresh');
		return json({ access_token: 'gho_new', refresh_token: 'ghr_new', expires_in: 100 });
	};
	const now = Date.parse('2026-09-30T00:00:00.000Z');
	const token = await refreshAccessToken('ghr_refresh', client, fetchImpl, now);
	assert.equal(token.accessToken, 'gho_new');
	assert.equal(token.refreshToken, 'ghr_new');
	assert.equal(token.expiresAt, new Date(now + 100 * 1000).toISOString());
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
