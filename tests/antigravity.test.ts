import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AcpProcess } from '../src/providers/acp/runtime.ts';

// config reads env at module load; the OAuth client must exist before oauth.ts is imported.
process.env.ANTIGRAVITY_CLIENT_ID = 'test-client-id';
process.env.ANTIGRAVITY_CLIENT_SECRET = 'test-client-secret';

const { antigravityAgent } = await import('../src/providers/acp/antigravity.ts');
const { antigravitySignIn, readCredential } = await import('../src/providers/antigravity/oauth.ts');
const { localCredential } = await import('../src/providers/acp/local-cli.ts');

const realFetch = globalThis.fetch;
/** Answers `fetch` from a table of handlers by URL prefix, recording each request. */
function stubFetch(handlers: Record<string, (request: Request) => Response | Promise<Response>>) {
	const seen: Request[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		seen.push(request.clone());
		const handler = Object.entries(handlers).find(([prefix]) => request.url.startsWith(prefix))?.[1];
		if (!handler) throw new Error(`Unexpected fetch ${request.url}`);
		return handler(request);
	}) as typeof fetch;
	return seen;
}
after(() => {
	globalThis.fetch = realFetch;
});

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

async function tempFile(): Promise<{ dir: string; file: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'anton-agy-'));
	return { dir, file: join(dir, 'oauth-token.json') };
}

test('descriptor exposes the agy ACP contract', async () => {
	const { file } = await tempFile();
	const agent = antigravityAgent({ credentialFile: file });
	assert.equal(agent.id, 'antigravity');
	assert.equal(agent.gateway, 'antigravity');
	assert.equal(agent.plan, 'Google Antigravity');
	assert.deepEqual(agent.command, ['agy', 'acp']);
	assert.equal(agent.modelConfigId, 'model');
	assert.equal(agent.auth.methodId, 'oauth-personal');
	// The whole file is the credential; authenticate takes no params — agy reads its own token store.
	assert.equal(agent.auth.credentialKey, '');
	assert.deepEqual(agent.auth.params('ignored'), {});
	assert.equal(agent.auth.credentialFile, file);
	assert.equal(agent.linkPort, 47910);
	assert.equal(agent.effortConfigId, 'thought_level');
	assert.deepEqual(agent.sessionConfig, { mode: 'auto' });
});

// The account's real session/new model list (Google AI Pro tier, agy 1.5.13): configOptions carry 9 base
// models while models.availableModels flattens each model × effort into its own id.
const AVAILABLE = [
	'gemini-4-neon-high',
	'gemini-4-neon-xhigh',
	'gemini-4-neon-medium',
	'gemini-4-neon-low',
	'gemini-4-argon-medium',
	'gemini-4-argon-high',
	'gemini-4-argon-low',
	'gemini-4-hydrogen-high',
	'gemini-4-hydrogen-xhigh',
	'gemini-4-hydrogen-medium',
	'gemini-4-hydrogen-low',
	'gemini-pro-orchestrator-neon',
	'gemini-pro-orchestrator-g1-pro',
	'gemini-3.8-flash-high',
	'gemini-3.8-flash-medium',
	'gemini-3.8-flash-low',
	'claude-opus-5-5-low',
	'claude-opus-5-5-medium',
	'claude-opus-5-5-high',
	'claude-sonnet-5-5-low',
	'claude-sonnet-5-5-medium',
	'claude-sonnet-5-5-high',
	'gpt-oss-120b-medium',
].map((modelId) => ({ modelId }));
const session = { models: { availableModels: AVAILABLE } };

test('modelInfo derives each model’s reasoning levels from its availableModels variants', async () => {
	const { file } = await tempFile();
	const agent = antigravityAgent({ credentialFile: file });
	const info = (value: string) => agent.modelInfo!(value, session);
	assert.deepEqual(info('gemini-4-neon'), { reasoning: ['low', 'medium', 'high', 'xhigh'], defaultReasoning: 'high', contextLength: 1_000_000 });
	assert.deepEqual(info('gemini-4-argon'), { reasoning: ['low', 'medium', 'high'], defaultReasoning: 'high', contextLength: 1_000_000 });
	assert.deepEqual(info('claude-opus-5-5'), { reasoning: ['low', 'medium', 'high'], defaultReasoning: 'high', contextLength: 200_000 });
	// Orchestrators and gpt-oss have no level variants — gpt-oss's "-medium" is part of its name, not a level.
	assert.deepEqual(info('gemini-pro-orchestrator-neon'), { contextLength: 1_000_000 });
	assert.deepEqual(info('gpt-oss-120b-medium'), { contextLength: 131_072 });
	// Prefixes must not leak across models.
	assert.deepEqual(info('gemini-4-ne'), { contextLength: 1_000_000 });
});

test('provision writes the token where agy reads it in the container', async () => {
	const { file } = await tempFile();
	const agent = antigravityAgent({ credentialFile: file });
	const written = new Map<string, string>();
	const proc = { writeFile: async (path: string, content: string) => void written.set(path, content) } as AcpProcess;
	await agent.auth.provision!(proc, '{"token":{}}');
	assert.equal(written.get('/root/.gemini/antigravity-cli/antigravity-oauth-token'), '{"token":{}}');
});

test('sign-in URL carries agy scopes, PKCE and the paste-back redirect', async () => {
	const { file } = await tempFile();
	const login = antigravitySignIn(file);
	const url = new URL(login.url);
	assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
	assert.equal(url.searchParams.get('client_id'), 'test-client-id');
	assert.equal(url.searchParams.get('redirect_uri'), 'https://antigravity.google/oauth-callback');
	assert.equal(url.searchParams.get('access_type'), 'offline');
	assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
	assert.ok(url.searchParams.get('scope')?.includes('cloud-platform'));
	assert.ok(url.searchParams.get('scope')?.includes('aicode'));
	assert.ok(url.searchParams.get('state'));
});

test('complete() trades a pasted callback URL for agy’s token-file shape', async () => {
	const { dir, file } = await tempFile();
	try {
		const login = antigravitySignIn(file);
		const state = new URL(login.url).searchParams.get('state')!;
		const seen = stubFetch({
			[TOKEN_ENDPOINT]: async (request) => {
				const body = new URLSearchParams(await request.text());
				assert.equal(body.get('grant_type'), 'authorization_code');
				assert.equal(body.get('code'), 'auth-code-123');
				assert.ok(body.get('code_verifier'));
				return Response.json({
					access_token: 'ya29.access',
					refresh_token: '1//refresh',
					expires_in: 3599,
					id_token: `h.${Buffer.from(JSON.stringify({ email: 'dev@example.com' })).toString('base64url')}.s`,
				});
			},
		});
		await login.complete(`https://antigravity.google/oauth-callback?code=auth-code-123&state=${state}`);
		assert.equal(seen.length, 1);
		const stored = JSON.parse(await readFile(file, 'utf8')) as {
			token: { access_token: string; refresh_token: string; token_type: string; expiry: string };
			auth_method: string;
			id_token_email: string;
		};
		assert.equal(stored.token.access_token, 'ya29.access');
		assert.equal(stored.token.refresh_token, '1//refresh');
		assert.equal(stored.token.token_type, 'Bearer');
		assert.equal(stored.auth_method, 'consumer');
		assert.equal(stored.id_token_email, 'dev@example.com');
		assert.ok(!Number.isNaN(Date.parse(stored.token.expiry)));
		// And the credential reader accepts what was written.
		assert.equal(await readCredential(file), await readFile(file, 'utf8'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('complete() keeps the stored refresh token when Google omits it on re-consent', async () => {
	const { dir, file } = await tempFile();
	try {
		await writeFile(file, JSON.stringify({ token: { refresh_token: '1//old' }, auth_method: 'consumer' }));
		const login = antigravitySignIn(file);
		const state = new URL(login.url).searchParams.get('state')!;
		stubFetch({
			[TOKEN_ENDPOINT]: () =>
				Response.json({ access_token: 'ya29.new', expires_in: 3600, id_token: `h.${Buffer.from(JSON.stringify({ email: 'dev@example.com' })).toString('base64url')}.s` }),
		});
		await login.complete(`https://antigravity.google/oauth-callback?code=c&state=${state}`);
		const stored = JSON.parse(await readFile(file, 'utf8')) as { token: { refresh_token: string } };
		assert.equal(stored.token.refresh_token, '1//old');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('complete() rejects a callback URL from a different sign-in', async () => {
	const { dir, file } = await tempFile();
	try {
		const login = antigravitySignIn(file);
		stubFetch({});
		await assert.rejects(
			login.complete('https://antigravity.google/oauth-callback?code=c&state=bogus-state'),
			/different sign-in/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readCredential accepts only files carrying a refresh token', async () => {
	const { dir, file } = await tempFile();
	try {
		assert.equal(await readCredential(file), null);
		await writeFile(file, 'not json');
		assert.equal(await readCredential(file), null);
		await writeFile(file, JSON.stringify({ token: { access_token: 'x' } }));
		assert.equal(await readCredential(file), null);
		await writeFile(file, JSON.stringify({ token: { refresh_token: 'r' } }));
		assert.ok(await readCredential(file));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('localCredential returns the raw file for credentialKey ""', async () => {
	const { dir, file } = await tempFile();
	try {
		const agent = antigravityAgent({ credentialFile: file });
		assert.equal(await localCredential(agent), null);
		await writeFile(file, JSON.stringify({ token: { refresh_token: 'r' } }));
		assert.equal(await localCredential(agent), JSON.stringify({ token: { refresh_token: 'r' } }));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('quota summary buckets become 5-hour and weekly windows', async () => {
	const { summaryWindows } = await import('../src/providers/antigravity/quota.ts');
	const now = Date.parse('2026-11-20T12:00:00Z');
	const windows = summaryWindows(
		{
			groups: [
				{
					displayName: 'Gemini models',
					buckets: [
						{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-11-20T17:00:00Z' },
						{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: '2026-11-27T00:00:00Z' },
						{ bucketId: 'gemini-off', window: 'weekly', remainingFraction: 0, disabled: true },
					],
				},
				{
					displayName: 'Partner models',
					buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-27T12:00:00Z', description: 'x' }],
				},
			],
		},
		now,
	);
	const byId = new Map([...windows].map(([id, w]) => [id, w]));
	assert.equal(byId.get('gemini-5h')?.label, 'Gemini · 5-hour');
	assert.equal(byId.get('gemini-5h')?.usedPercent, 20);
	assert.equal(byId.get('gemini-5h')?.resetsAt, '2026-11-20T17:00:00.000Z');
	assert.equal(byId.get('gemini-weekly')?.label, 'Gemini · Weekly');
	assert.equal(byId.get('gemini-weekly')?.usedPercent, 60);
	assert.equal(byId.has('gemini-off'), false);
	assert.equal(byId.get('3p-weekly')?.label, 'Claude & GPT (shared) · Weekly');
});

test('an untouched bucket hides its rolling reset', async () => {
	const { summaryWindows } = await import('../src/providers/antigravity/quota.ts');
	const now = Date.parse('2026-11-20T12:00:00Z');
	const windows = summaryWindows(
		{ buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-27T12:00:00Z' }] },
		now,
	);
	assert.equal(windows.get('gemini-weekly')?.resetsAt, null);
});

test('model-level quotas cover accounts without a summary', async () => {
	const { modelWindows } = await import('../src/providers/antigravity/quota.ts');
	const windows = modelWindows({
		models: {
			'gemini-4-neon': { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.5 }, weeklyQuotaInfo: { remainingFraction: 0.25, resetTime: '2026-11-27T00:00:00Z' } },
			'claude-opus': { modelProvider: 'MODEL_PROVIDER_ANTHROPIC', quotaInfo: { remainingFraction: 1 } },
			'unknown-model': { quotaInfo: { remainingFraction: 0.1 } },
		},
	});
	assert.equal(windows.get('gemini-quota')?.label, 'Gemini · Reported quota');
	assert.equal(windows.get('gemini-quota')?.usedPercent, 50);
	assert.equal(windows.get('gemini-weekly')?.usedPercent, 75);
	assert.equal(windows.get('claude-quota')?.usedPercent, 0);
	assert.equal(windows.has('unknown-model-quota'), false);
});
