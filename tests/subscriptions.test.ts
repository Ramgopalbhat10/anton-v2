import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { ModelInfo, SubscriptionCredential, SubscriptionModel, SubscriptionProvider } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-subscriptions-'));
process.env.ANTON_DATA_DIR = dir;

const { chatGptSubscription, CHATGPT_REDIRECT_URI, toSubscriptionModel } = await import('../src/providers/chatgpt/subscription.ts');
const { chatGptPlanProvider, forChatGptPlan } = await import('../src/flue/subscription-models.ts');
const { setProviders } = await import('../src/providers/index.ts');
const subscriptions = await import('../src/services/subscriptions.ts');
const { listModels } = await import('../src/services/models.ts');
const { onChange } = await import('../src/core/changes.ts');
const { createModels } = await import('@earendil-works/pi-ai');

after(() => {
	subscriptions.resetSubscriptionsForTests();
	rmSync(dir, { recursive: true, force: true });
});

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

const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const tokenResponse = (patch: object = {}) =>
	Response.json({
		access_token: 'access-1',
		refresh_token: 'refresh-1',
		id_token: idToken({ email: 'ada@example.com' }),
		expires_in: 3600,
		scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
		...patch,
	});

test('a first sign-in registers Anton; a sign-in again reuses its client and names the account', () => {
	const provider = chatGptSubscription();
	const first = new URL(provider.startLogin('urn:uuid:host').url);
	assert.equal(first.origin + first.pathname, 'https://auth.openai.com/api/accounts/authorize');
	const params = Object.fromEntries(first.searchParams);
	assert.equal(params.client_id, 'dynamic_agent_client');
	assert.equal(params.agent_name_hint, 'Anton');
	assert.equal(params.ext_agent_host_id, 'urn:uuid:host');
	assert.equal(params.redirect_uri, CHATGPT_REDIRECT_URI);
	assert.equal(params.resource, 'https://api.openai.com/v1');
	assert.equal(params.code_challenge_method, 'S256');
	assert.match(params.scope, /chatgpt\.tokens\.use\.direct/);
	assert.ok(params.state && params.nonce && params.code_challenge);

	const again = new URL(provider.startLogin('urn:uuid:host', { clientId: 'oaiapp_1', email: 'ada@example.com' }).url).searchParams;
	assert.equal(again.get('client_id'), 'oaiapp_1');
	assert.equal(again.get('agent_name_hint'), null);
	assert.equal(again.get('login_hint'), 'ada@example.com');
});

test('the address the browser lands on is checked before its code is exchanged for a plan token', async () => {
	const provider = chatGptSubscription();
	const login = provider.startLogin('urn:uuid:host');
	const state = new URL(login.url).searchParams.get('state')!;
	await assert.rejects(login.complete('not a url'), /Paste the whole address/);
	await assert.rejects(login.complete(`http://localhost:1455/auth/callback?state=${state}&code=c`), /Paste the whole address/);
	await assert.rejects(login.complete(`${CHATGPT_REDIRECT_URI}?state=other&code=c&client_id=oaiapp_1`), /different sign-in/);
	await assert.rejects(login.complete(`${CHATGPT_REDIRECT_URI}?state=${state}&error=access_denied`), /cancelled/);
	await assert.rejects(login.complete(`${CHATGPT_REDIRECT_URI}?state=${state}&code=c`), /which client/);

	const seen = stubFetch({ 'https://auth.openai.com/api/accounts/oauth/token': () => tokenResponse() });
	const credential = await login.complete(`${CHATGPT_REDIRECT_URI}?state=${state}&code=the-code&client_id=oaiapp_1`);
	assert.equal(credential.access, 'access-1');
	assert.equal(credential.clientId, 'oaiapp_1');
	assert.equal(credential.email, 'ada@example.com');
	assert.ok(credential.expiresAt > Date.now() && credential.expiresAt < Date.now() + 3600_000);
	const sent = new URLSearchParams(await seen[0].text());
	assert.equal(sent.get('grant_type'), 'authorization_code');
	assert.equal(sent.get('code'), 'the-code');
	assert.equal(sent.get('client_id'), 'oaiapp_1');
	assert.equal(sent.get('redirect_uri'), CHATGPT_REDIRECT_URI);
	assert.ok(sent.get('code_verifier'));

	stubFetch({ 'https://auth.openai.com/api/accounts/oauth/token': () => tokenResponse({ scope: 'openid email' }) });
	const other = provider.startLogin('urn:uuid:host');
	const otherState = new URL(other.url).searchParams.get('state')!;
	await assert.rejects(other.complete(`${CHATGPT_REDIRECT_URI}?state=${otherState}&code=c&client_id=oaiapp_1`), /did not allow Anton to use your plan/);
});

test('the account lists its models; pi fills in what the list leaves out, and hidden ones are left out', async () => {
	const listed = toSubscriptionModel({ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' }, 'openai')!;
	assert.equal(listed.id, 'openai/gpt-5.5');
	assert.equal(listed.name, 'GPT-5.5');
	assert.equal(listed.contextLength, 272_000);
	assert.equal(listed.vision, true);
	assert.deepEqual(listed.reasoning, ['off', 'low', 'medium', 'high', 'xhigh']);
	assert.equal(listed.defaultReasoning, 'medium');
	assert.equal(listed.listPrice?.output, 30);
	assert.equal(toSubscriptionModel({ slug: 'gpt-5.5', visibility: 'hide' }, 'openai'), null);

	const own = toSubscriptionModel(
		{ slug: 'gpt-6.1-sol', context_window: 400_000, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'high' },
		'openai',
	)!;
	assert.deepEqual(own.reasoning, ['low', 'high']);
	assert.equal(own.defaultReasoning, 'high');
	assert.equal(own.contextLength, 400_000);
	assert.equal(own.listPrice, null);

	const seen = stubFetch({ 'https://api.openai.com/v1/models': () => Response.json({ models: [{ slug: 'gpt-5.5', visibility: 'list' }, { slug: 'internal', visibility: 'hide' }] }) });
	const models = await chatGptSubscription().listModels('access-1');
	assert.deepEqual(models.map((model) => model.id), ['openai/gpt-5.5']);
	assert.equal(seen[0].headers.get('authorization'), 'Bearer access-1');
});

test('a plan request drops the fields OpenAI rejects for plan tokens, and sends system text as developer', () => {
	const request = forChatGptPlan({
		model: 'gpt-5.5',
		store: true,
		max_output_tokens: 32_000,
		temperature: 0.2,
		prompt_cache_retention: '24h',
		prompt_cache_key: 'task-1',
		input: [
			{ role: 'system', content: 'Be brief.' },
			{ role: 'user', content: 'Hi' },
		],
	}) as Record<string, unknown>;
	assert.equal(request.store, false);
	assert.equal(request.stream, true);
	for (const field of ['max_output_tokens', 'temperature', 'prompt_cache_retention']) assert.equal(field in request, false, field);
	assert.equal(request.prompt_cache_key, 'task-1');
	assert.deepEqual(request.input, [
		{ role: 'developer', content: 'Be brief.' },
		{ role: 'user', content: 'Hi' },
	]);
});

const SSE = [
	{ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
	{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
	{ type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
	{ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ready' },
	{ type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: 'ready' },
	{
		type: 'response.output_item.done',
		output_index: 0,
		item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ready', annotations: [] }] },
	},
	{
		type: 'response.completed',
		response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } } },
	},
];

test('a plan model call through pi sends the fresh token, no output cap and a developer system prompt', async () => {
	const info: ModelInfo = {
		id: 'openai/gpt-5.5',
		name: 'GPT-5.5',
		vendor: 'OpenAI',
		description: '',
		createdAt: 0,
		contextLength: 272_000,
		maxOutput: 128_000,
		price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		vision: true,
		reasoning: ['off', 'low', 'medium', 'high'],
		defaultReasoning: 'medium',
		subscription: 'ChatGPT',
	};
	const live = [info, { ...info, id: 'openrouter/openai/gpt-5.5' }];
	const models = createModels();
	models.setProvider(chatGptPlanProvider(() => live, async () => 'plan-token'));
	const model = models.getModel('openai', 'gpt-5.5');
	assert.ok(model, 'the plan model resolves under openai/');
	assert.equal(models.getModel('openai', 'openai/gpt-5.5'), undefined, 'gateway models stay with their gateway');

	const seen = stubFetch({
		'https://api.openai.com/v1/responses': () =>
			new Response(SSE.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }),
	});
	const reply = await models.completeSimple(model, { systemPrompt: 'Be brief.', messages: [{ role: 'user', content: 'Say ready.', timestamp: Date.now() }] }, { reasoning: 'low' });
	assert.equal(reply.stopReason, 'stop', reply.errorMessage);
	assert.equal(reply.usage.cost.total, 0);
	assert.equal(seen[0].headers.get('authorization'), 'Bearer plan-token');
	const body = (await seen[0].json()) as Record<string, unknown>;
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
	assert.equal('max_output_tokens' in body, false);
	assert.deepEqual(body.reasoning, { effort: 'low', summary: 'auto' });
	assert.equal((body.input as Array<{ role?: string }>)[0].role, 'developer');
});

/** A plan whose sign-in and model list Anton drives, with every call to the vendor recorded. */
function fakePlan() {
	const calls = { refresh: 0, list: 0 };
	let refreshFails: Error | null = null;
	const credential = (n: number): SubscriptionCredential => ({
		access: `access-${n}`,
		refresh: `refresh-${n}`,
		expiresAt: Date.now() + 3600_000,
		clientId: 'oaiapp_1',
		scopes: ['chatgpt.tokens.use.direct'],
		email: 'ada@example.com',
	});
	const model: SubscriptionModel = {
		id: 'openai/gpt-5.5',
		name: 'GPT-5.5',
		vendor: 'OpenAI',
		description: '',
		createdAt: 0,
		contextLength: 272_000,
		maxOutput: null,
		vision: true,
		reasoning: ['low', 'medium'],
		defaultReasoning: 'medium',
		listPrice: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
	};
	const provider: SubscriptionProvider = {
		id: 'chatgpt',
		name: 'ChatGPT',
		gateway: 'openai',
		startLogin: (hostId, previous) => ({
			url: `https://auth.example/authorize?host=${hostId}&client=${previous?.clientId ?? 'new'}`,
			redirectUri: 'http://127.0.0.1:1/auth/callback',
			complete: async (callbackUrl) => {
				if (!callbackUrl.includes('code=ok')) throw new Error('No code');
				return credential(1);
			},
		}),
		refresh: async (current) => {
			calls.refresh += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (refreshFails) throw refreshFails;
			return { ...credential(calls.refresh + 1), email: current.email };
		},
		listModels: async () => {
			calls.list += 1;
			return [model];
		},
	};
	return { provider, calls, failRefresh: (error: Error | null) => (refreshFails = error) };
}

const fakeCatalog = { name: 'openrouter', list: async () => [] as ModelInfo[] };

beforeEach(async () => {
	subscriptions.resetSubscriptionsForTests();
	const { appDb } = await import('../src/db/client.ts');
	await (await appDb()).execute("DELETE FROM settings WHERE key LIKE 'subscription%'");
});

test('signing in by pasting the return address connects the plan, offers its models free, and announces it', async () => {
	const plan = fakePlan();
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: fakeCatalog, subscriptions: [plan.provider] });
	const changes: unknown[] = [];
	const stop = onChange((change) => changes.push(change));
	try {
		assert.equal((await subscriptions.subscriptionsView())[0].state, 'signed-out');
		await assert.rejects(subscriptions.finishLogin('chatgpt', 'http://127.0.0.1:1/auth/callback?code=ok'), /No sign-in is waiting/);

		const started = await subscriptions.beginLogin('chatgpt');
		assert.match(started.login!.url, /host=urn:uuid:[0-9a-f-]{36}&client=new/);
		await assert.rejects(subscriptions.finishLogin('chatgpt', 'http://127.0.0.1:1/auth/callback'), /No code/);
		const done = await subscriptions.finishLogin('chatgpt', 'http://127.0.0.1:1/auth/callback?code=ok');
		assert.equal(done.state, 'connected');
		assert.equal(done.email, 'ada@example.com');
		assert.equal(done.login, null);
		assert.deepEqual(
			done.models.map((model) => [model.id, model.name, model.reasoning, model.tokens]),
			[['openai/gpt-5.5', 'GPT-5.5', ['low', 'medium'], 0]],
		);
		assert.ok(done.expiresAt);
		assert.ok(changes.some((change) => (change as { kind: string }).kind === 'subscriptions'));

		// A task's calls on the plan model show as that model's tokens this month.
		const { upsertProject } = await import('../src/db/projects.ts');
		const { insertSession, addSessionUsage } = await import('../src/db/sessions.ts');
		const project = await upsertProject('acme/plan', 'main');
		await insertSession({ id: 'on-plan', projectId: project.id, title: 'On plan', model: 'openai/gpt-5.5', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });
		await addSessionUsage('on-plan', { inputTokens: 900, outputTokens: 100, cost: 0 }, new Date(), 'openai/gpt-5.5', 'turn-1');
		const [withUsage] = await subscriptions.subscriptionsView();
		assert.equal(withUsage.models[0].tokens, 1000);
		assert.equal(withUsage.monthTokens, 1000);

		const [listed] = await listModels();
		assert.equal(listed.id, 'openai/gpt-5.5');
		assert.equal(listed.subscription, 'ChatGPT');
		assert.deepEqual(listed.price, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		await subscriptions.setSubscriptionOptions('chatgpt', { enabled: true, countAtApiPrices: true });
		assert.equal((await listModels())[0].price.output, 30);
		await subscriptions.setSubscriptionOptions('chatgpt', { enabled: false, countAtApiPrices: true });
		assert.deepEqual(await listModels(), []);
		assert.equal(plan.calls.list, 1, 'the list is reused within the hour');

		// Signing in again reuses the client the first sign-in registered.
		assert.match((await subscriptions.beginLogin('chatgpt')).login!.url, /client=oaiapp_1/);
		await subscriptions.cancelLogin('chatgpt');
	} finally {
		stop();
	}
});

test('an expired token is renewed once for concurrent calls, and a revoked sign-in says to sign in again', async () => {
	const plan = fakePlan();
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: fakeCatalog, subscriptions: [plan.provider] });
	await assert.rejects(subscriptions.gatewayToken('openai'), /not signed in/);
	await assert.rejects(subscriptions.gatewayToken('anthropic'), /No subscription serves/);

	await subscriptions.importLogin('chatgpt', JSON.stringify({ openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 0, clientId: 'oaiapp_1' } }));
	assert.equal(plan.calls.refresh, 1, 'importing renews at once, which checks it and takes it over');
	assert.equal(await subscriptions.gatewayToken('openai'), 'access-2');

	const { appDb } = await import('../src/db/client.ts');
	const db = await appDb();
	const stored = JSON.parse(String((await db.execute("SELECT value FROM settings WHERE key = 'subscription.chatgpt'")).rows[0].value));
	await db.execute({ sql: "UPDATE settings SET value = ? WHERE key = 'subscription.chatgpt'", args: [JSON.stringify({ ...stored, credential: { ...stored.credential, expiresAt: 0 } })] });
	subscriptions.resetSubscriptionsForTests();
	const tokens = await Promise.all([subscriptions.gatewayToken('openai'), subscriptions.gatewayToken('openai'), subscriptions.accessToken('chatgpt')]);
	assert.deepEqual(new Set(tokens), new Set(['access-3']));
	assert.equal(plan.calls.refresh, 2);

	await db.execute({ sql: "UPDATE settings SET value = ? WHERE key = 'subscription.chatgpt'", args: [JSON.stringify({ ...stored, credential: { ...stored.credential, expiresAt: 0 } })] });
	subscriptions.resetSubscriptionsForTests();
	plan.failRefresh(new Error('ChatGPT sign-in failed (400): invalid_grant'));
	await assert.rejects(subscriptions.gatewayToken('openai'), /Could not renew/);
	const [view] = await subscriptions.subscriptionsView();
	assert.equal(view.state, 'expired');
	await assert.rejects(subscriptions.gatewayToken('openai'), /Sign in again/);

	const out = await subscriptions.disconnect('chatgpt');
	assert.equal(out.state, 'signed-out');
	assert.deepEqual(out.models, []);
});

test('a sign-in from another computer is read from pi’s auth.json or OpenAI’s saved record', () => {
	assert.deepEqual(subscriptions.parseImported(JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 1, clientId: 'oaiapp_1' })), {
		refresh: 'r',
		clientId: 'oaiapp_1',
		access: 'a',
		scopes: [],
		email: null,
	});
	assert.equal(subscriptions.parseImported(JSON.stringify({ client_id: 'oaiapp_2', refresh_token: 'r2', access_token: 'a2', scopes: ['x'] })).clientId, 'oaiapp_2');
	assert.throws(() => subscriptions.parseImported('nope'), /as JSON/);
	assert.throws(() => subscriptions.parseImported('{"openai":{"type":"api_key","key":"sk"}}'), /no refresh token/);
});
