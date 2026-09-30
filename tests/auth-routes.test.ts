import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { sealState } from '../src/lib/crypto.ts';

const root = mkdtempSync(path.join(tmpdir(), 'anton-auth-routes-'));
process.env.TURSO_DATABASE_URL = `file:${path.join(root, 'anton.db')}`;
process.env.GITHUB_CLIENT_ID = '';
process.env.GITHUB_CLIENT_SECRET = '';
process.env.SESSION_SECRET = 'route-session-secret';
process.env.TOKEN_ENCRYPTION_KEY = 'route-token-key';
process.env.GITHUB_CALLBACK_URL = 'http://127.0.0.1:43127/api/auth/github/callback';

const { default: app } = await import('../src/app.ts');
const { env } = await import('../src/lib/env.ts');

after(() => {
	rmSync(root, { recursive: true, force: true });
});

test('GitHub login reports that OAuth is not configured', async () => {
	env.githubClientId = '';
	env.githubClientSecret = '';
	const response = await app.request('/api/auth/github');
	assert.equal(response.status, 400);
	const body = (await response.json()) as { error: string };
	assert.match(body.error, /not configured/i);
});

test('GitHub login redirects and the callback sets a session cookie', async () => {
	env.githubClientId = 'cid';
	env.githubClientSecret = 'csec';
	const start = await app.request('/api/auth/github');
	assert.equal(start.status, 302);
	const location = new URL(start.headers.get('location') ?? '');
	assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
	const cookie = start.headers.get('set-cookie') ?? '';
	const nonce = /anton_oauth_state=([^;]+)/.exec(cookie)?.[1];
	assert.ok(nonce);
	assert.equal(location.searchParams.get('state'), sealState(nonce, env.sessionSecret));

	const original = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes('access_token')) return Response.json({ access_token: 'gho_route', expires_in: 3600 });
		if (url.endsWith('/user')) {
			return Response.json({ id: 5, login: 'route-user', avatar_url: null, name: 'Route', email: 'route@example.test' });
		}
		throw new Error(`unexpected ${url}`);
	};
	try {
		const callback = await app.request(`/api/auth/github/callback?code=abc&state=${location.searchParams.get('state')}`, {
			headers: { cookie: `anton_oauth_state=${nonce}` },
		});
		assert.equal(callback.status, 302);
		assert.equal(callback.headers.get('location'), '/');
		const session = /anton_session=([^;]+)/.exec(callback.headers.get('set-cookie') ?? '')?.[1];
		assert.ok(session);
		const me = await app.request('/api/auth/me', { headers: { cookie: `anton_session=${session}` } });
		const body = (await me.json()) as { oauth: boolean; user: { login: string } };
		assert.equal(body.oauth, true);
		assert.equal(body.user.login, 'route-user');
		const sessions = await app.request('/api/sessions');
		assert.equal(sessions.status, 401);
	} finally {
		globalThis.fetch = original;
	}
});
