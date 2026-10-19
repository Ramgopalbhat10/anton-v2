import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-mcp-sign-in-'));
process.env.ANTON_DATA_DIR = dir;

const servers = await import('../src/services/mcp-servers.ts');
const signIns = await import('../src/services/mcp-sign-in.ts');

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => signIns.resetMcpSignInsForTests());

const ANTON = 'https://anton.test';
const CALLBACK = `${ANTON}/api/mcp-servers/callback`;

/** An MCP server whose sign-in is a separate authorization server, as Linear's and Notion's are. */
function fakeOAuth({ registration = true, expiresIn = 3600 } = {}) {
	const seen: Array<{ url: string; body: string }> = [];
	let issued = 0;
	let refuseRefresh = false;
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const body = init?.body ? String(init.body) : '';
		seen.push({ url, body });
		if (url === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') {
			return json({ resource: 'https://mcp.test/mcp', authorization_servers: ['https://auth.test'], scopes_supported: ['read', 'write'] });
		}
		if (url === 'https://auth.test/.well-known/oauth-authorization-server') {
			return json({
				issuer: 'https://auth.test',
				authorization_endpoint: 'https://auth.test/authorize',
				token_endpoint: 'https://auth.test/token',
				...(registration ? { registration_endpoint: 'https://auth.test/register' } : {}),
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256'],
				grant_types_supported: ['authorization_code', 'refresh_token'],
				token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
			});
		}
		if (url === 'https://auth.test/register') return json({ ...JSON.parse(body), client_id: 'anton-1' }, 201);
		if (url === 'https://auth.test/token') {
			const form = new URLSearchParams(body);
			if (form.get('grant_type') === 'refresh_token' && refuseRefresh) return json({ error: 'invalid_grant', error_description: 'revoked' }, 400);
			issued += 1;
			return json({ access_token: `at-${issued}`, token_type: 'Bearer', expires_in: expiresIn, refresh_token: `rt-${issued}` });
		}
		return new Response('not found', { status: 404 });
	}) as typeof fetch;
	return {
		seen,
		refuse: () => {
			refuseRefresh = true;
		},
		tokenRequests: () => seen.filter((request) => request.url === 'https://auth.test/token').map((request) => new URLSearchParams(request.body)),
	};
}

async function add(name: string) {
	await servers.addMcpServer({ name, url: 'https://mcp.test/mcp', tools: [] });
}

/** Signs in as the browser would: start, follow the server's page back to Anton with a code. */
async function signIn(name: string) {
	const { url } = await signIns.beginMcpSignIn(name, ANTON);
	assert.ok(url);
	const state = new URL(url).searchParams.get('state') ?? '';
	return { url: new URL(url), finished: await signIns.finishMcpSignIn(new URLSearchParams({ code: 'code-1', state })) };
}

const viewOf = async (name: string) => (await servers.mcpServersView()).find((server) => server.name === name);

test('a server signs in with OAuth: Anton registers itself, sends you to sign in, and hands the agent the token', async () => {
	const oauth = fakeOAuth();
	await add('tracker');
	assert.equal((await viewOf('tracker'))?.signIn.state, 'none');

	const { url, finished } = await signIn('tracker');
	assert.equal(finished, 'tracker');
	assert.equal(url.origin + url.pathname, 'https://auth.test/authorize');
	assert.equal(url.searchParams.get('client_id'), 'anton-1');
	assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
	assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
	assert.equal(url.searchParams.get('resource'), 'https://mcp.test/mcp');
	const registered = JSON.parse(oauth.seen.find((request) => request.url === 'https://auth.test/register')?.body ?? '{}');
	assert.deepEqual(registered.redirect_uris, [CALLBACK]);
	assert.equal(registered.token_endpoint_auth_method, 'none');
	const exchange = oauth.tokenRequests()[0];
	assert.equal(exchange?.get('grant_type'), 'authorization_code');
	assert.ok(exchange?.get('code_verifier'), 'the code is exchanged with its PKCE verifier');

	const view = await viewOf('tracker');
	assert.equal(view?.signIn.state, 'signed-in');
	assert.ok(!JSON.stringify(await servers.mcpServersView()).includes('at-1'), 'no view carries the token');
	assert.equal((await servers.enabledMcpServers()).find((server) => server.name === 'tracker')?.auth, 'at-1');
});

test('a token about to run out is renewed once, however many ask, and a refused renewal asks you to sign in again', async () => {
	const oauth = fakeOAuth({ expiresIn: 60 });
	await add('renews');
	await signIn('renews');
	const [first, second] = await Promise.all([servers.enabledMcpServers(), servers.enabledMcpServers()]);
	const token = (list: typeof first) => list.find((server) => server.name === 'renews')?.auth;
	assert.equal(token(first), 'at-2');
	assert.equal(token(second), 'at-2');
	const refreshes = oauth.tokenRequests().filter((form) => form.get('grant_type') === 'refresh_token');
	assert.equal(refreshes.length, 1);
	assert.equal(refreshes[0]?.get('refresh_token'), 'rt-1');

	oauth.refuse();
	assert.equal(token(await servers.enabledMcpServers()), undefined, 'a server whose sign-in was refused is left out');
	const view = await viewOf('renews');
	assert.equal(view?.signIn.state, 'needed');
	assert.match(view?.signIn.problem ?? '', /Sign in again/);
	await assert.rejects(servers.mcpServerTools('renews'), /Sign in again/);
});

test('a server that lets no app register itself takes a client you paste, and keeps it when you sign out', async () => {
	fakeOAuth({ registration: false });
	await add('closed');
	await assert.rejects(signIns.beginMcpSignIn('closed', ANTON), /doesn't let apps register themselves/);

	const { url } = await signIns.beginMcpSignIn('closed', ANTON, { clientId: 'pasted-id', clientSecret: 'shh' });
	assert.equal(new URL(url ?? '').searchParams.get('client_id'), 'pasted-id');
	await signIns.finishMcpSignIn(new URLSearchParams({ code: 'c', state: new URL(url ?? '').searchParams.get('state') ?? '' }));
	assert.equal((await viewOf('closed'))?.signIn.state, 'signed-in');
	assert.ok(!JSON.stringify(await servers.mcpServersView()).includes('shh'), 'no view carries the client secret');

	await signIns.signOutOfMcpServer('closed');
	const view = await viewOf('closed');
	assert.equal(view?.signIn.state, 'none');
	assert.equal(view?.signIn.clientId, 'pasted-id');
	assert.equal((await servers.enabledMcpServers()).find((server) => server.name === 'closed')?.auth, null);
});

test("Google's MCP servers sign in with your Google client and ask for a refresh token, as Google needs", async () => {
	const seen: Array<{ url: string; body: string; headers: Headers }> = [];
	const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		seen.push({ url, body: init?.body ? String(init.body) : '', headers: new Headers(init?.headers) });
		if (url === 'https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1') {
			return json({ resource: 'https://gmailmcp.googleapis.com/mcp/v1', authorization_servers: ['https://accounts.google.com/'], scopes_supported: ['https://www.googleapis.com/auth/gmail.readonly'] });
		}
		if (url === 'https://accounts.google.com/.well-known/oauth-authorization-server') {
			return json({
				issuer: 'https://accounts.google.com',
				authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
				token_endpoint: 'https://oauth2.googleapis.com/token',
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256'],
				token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
			});
		}
		if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'ya29', token_type: 'Bearer', expires_in: 3599, refresh_token: '1//r' });
		return new Response('not found', { status: 404 });
	}) as typeof fetch;
	await servers.addMcpServer({ name: 'gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', tools: [] });
	await assert.rejects(signIns.beginMcpSignIn('gmail', ANTON), /doesn't let apps register themselves/);

	const { url } = await signIns.beginMcpSignIn('gmail', ANTON, { clientId: 'web.apps.googleusercontent.com', clientSecret: 'GOCSPX' });
	const at = new URL(url ?? '');
	assert.equal(at.searchParams.get('access_type'), 'offline');
	assert.equal(at.searchParams.get('prompt'), 'consent');
	await signIns.finishMcpSignIn(new URLSearchParams({ code: 'c', state: at.searchParams.get('state') ?? '' }));
	const exchange = seen.find((request) => request.url === 'https://oauth2.googleapis.com/token');
	assert.match(exchange?.headers.get('authorization') ?? '', /^Basic /, 'the code is exchanged with the client secret, as Google requires');
	assert.equal((await servers.enabledMcpServers()).find((server) => server.name === 'gmail')?.auth, 'ya29');
});

test('a server that offers no OAuth sign-in says so, rather than failing somewhere in the flow', async () => {
	fakeOAuth();
	await servers.addMcpServer({ name: 'open', url: 'https://open.test/mcp', tools: [] });
	await assert.rejects(signIns.beginMcpSignIn('open', ANTON), /doesn't offer an OAuth sign-in/);
	assert.equal((await viewOf('open'))?.signIn.state, 'none');
});

test('a sign-in is only finished once, with its own state, and pointing the server elsewhere forgets it', async () => {
	fakeOAuth();
	await add('moves');
	await assert.rejects(signIns.finishMcpSignIn(new URLSearchParams({ code: 'c', state: 'made-up' })), /expired or was already used/);
	const { url } = await signIns.beginMcpSignIn('moves', ANTON);
	const state = new URL(url ?? '').searchParams.get('state') ?? '';
	await assert.rejects(signIns.finishMcpSignIn(new URLSearchParams({ error: 'access_denied', state })), /declined/);
	await assert.rejects(signIns.finishMcpSignIn(new URLSearchParams({ code: 'c', state })), /already used/);

	await signIn('moves');
	assert.equal((await viewOf('moves'))?.signIn.state, 'signed-in');
	await servers.updateMcpServer('moves', { url: 'https://mcp.test/other', tools: [] });
	assert.equal((await viewOf('moves'))?.signIn.state, 'none');
	assert.equal((await servers.enabledMcpServers()).find((server) => server.name === 'moves')?.auth, null);
});
