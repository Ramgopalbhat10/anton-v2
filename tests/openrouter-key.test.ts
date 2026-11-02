import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { GatewayAccount, ModelInfo } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-openrouter-key-'));
process.env.ANTON_DATA_DIR = dir;

const { config } = await import('../src/config.ts');
const { openRouterAccount, toWindows, toCredits } = await import('../src/providers/openrouter/account.ts');
const { openRouterCatalog } = await import('../src/providers/openrouter/catalog.ts');
const { openRouterKey, openRouterKeySource } = await import('../src/providers/openrouter/key.ts');
const { liveOpenRouterProvider } = await import('../src/flue/live-models.ts');
const { setProviders } = await import('../src/providers/index.ts');
const subscriptions = await import('../src/services/subscriptions.ts');
const { listModels } = await import('../src/services/models.ts');
const { createModels } = await import('@earendil-works/pi-ai');

const API = 'https://openrouter.ai/api/v1';
const realFetch = globalThis.fetch;
const serverKey = config.openrouter.apiKey;

/** Answers `fetch` from a table of handlers by URL, recording each request. */
function stubFetch(handlers: Record<string, (request: Request) => Response | Promise<Response>>) {
	const seen: Request[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		seen.push(request.clone());
		const handler = handlers[request.url.split('?')[0]];
		if (!handler) throw new Error(`Unexpected fetch ${request.url}`);
		return handler(request);
	}) as typeof fetch;
	return seen;
}

after(() => {
	globalThis.fetch = realFetch;
	config.openrouter.apiKey = serverKey;
	subscriptions.resetSubscriptionsForTests();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	globalThis.fetch = realFetch;
	config.openrouter.apiKey = '';
	subscriptions.resetSubscriptionsForTests();
	const { appDb } = await import('../src/db/client.ts');
	await (await appDb()).execute("DELETE FROM settings WHERE key LIKE 'subscription%'");
});

const keyInfo = {
	data: {
		label: 'sk-or-v1-0a2...15a',
		limit: 10,
		usage: 2,
		budgets: [
			{ scope: 'workspace', limit_usd: 10, spend_usd: 2.5, remaining_usd: 7.5, reset_interval: 'daily', resets_at: '2026-10-17T00:00:00.000Z' },
			{ scope: 'key_limit', limit_usd: 10, spend_usd: 10, remaining_usd: 0, reset_interval: null, resets_at: null },
			{ scope: 'key_limit', limit_usd: null, spend_usd: 1, remaining_usd: null, reset_interval: 'weekly', resets_at: null },
		],
	},
};

test('OpenRouter checks a key with GET /key, and reads its spending limits and credits', async () => {
	const seen = stubFetch({
		[`${API}/key`]: (request) => (request.headers.get('authorization') === 'Bearer sk-or-good' ? Response.json(keyInfo) : new Response('no', { status: 401 })),
		[`${API}/credits`]: () => Response.json({ data: { total_credits: 20, total_usage: 5 } }),
	});
	const account = openRouterAccount({ apiUrl: API });
	assert.deepEqual(await account.check('sk-or-good'), { email: null });
	await assert.rejects(account.check('sk-or-bad'), /did not accept that key/);
	assert.deepEqual(await account.windows!('sk-or-good'), [
		{ label: 'Workspace daily', usedPercent: 25, resetsAt: '2026-10-17T00:00:00.000Z', limited: false },
		{ label: 'Key limit', usedPercent: 100, resetsAt: null, limited: true },
		{ label: 'Credits', usedPercent: 25, resetsAt: null, limited: false },
	]);
	assert.equal(seen[0].headers.get('authorization'), 'Bearer sk-or-good');

	assert.deepEqual(toWindows({ data: { limit: 4, usage: 1, limit_remaining: 3 } }), [{ label: 'Key limit', usedPercent: 25, resetsAt: null, limited: false }]);
	assert.deepEqual(toWindows({ data: { limit: null, usage: 1 } }), [], 'a key with no limit has nothing to show');
	assert.deepEqual(toWindows(null), []);
	assert.equal(toCredits({ data: { total_credits: 0, total_usage: 0 } }), null);
});

test('the catalog lists the models a key may use, and the public list without one', async () => {
	const model = (id: string) => ({ id, name: `Lab: ${id}`, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } });
	let key: string | null = null;
	let userListFails = false;
	const seen = stubFetch({
		[`${API}/models`]: () => Response.json({ data: [model('lab/public')] }),
		[`${API}/models/user`]: () => (userListFails ? new Response('down', { status: 500 }) : Response.json({ data: [model('lab/for-key')] })),
	});
	const catalog = openRouterCatalog({ apiUrl: API, ttlMs: 60_000, apiKey: () => key });

	assert.deepEqual((await catalog.list()).map((info) => info.id), ['openrouter/lab/public']);
	assert.equal(seen[0].headers.get('authorization'), null);
	key = 'sk-or-1';
	assert.deepEqual((await catalog.list()).map((info) => info.id), ['openrouter/lab/for-key'], 'a new key lists again at once');
	assert.equal(seen[1].headers.get('authorization'), 'Bearer sk-or-1');
	await catalog.list();
	assert.equal(seen.length, 2, 'the list is cached for the same key');
	userListFails = true;
	assert.deepEqual((await catalog.list(true)).map((info) => info.id), ['openrouter/lab/public'], 'the public list stands in when the key’s list fails');
});

test('once its hour is up the catalog serves the last list at once and swaps in the new one when it lands', async () => {
	const model = (id: string) => ({ id, name: `Lab: ${id}`, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } });
	let answer = (): Response | Promise<Response> => Response.json({ data: [model('lab/old')] });
	const seen = stubFetch({ [`${API}/models`]: () => answer() });
	const catalog = openRouterCatalog({ apiUrl: API, ttlMs: 0, apiKey: () => null });
	assert.deepEqual((await catalog.list()).map((info) => info.id), ['openrouter/lab/old']);

	let land = () => {};
	answer = () => new Promise((resolve) => (land = () => resolve(Response.json({ data: [model('lab/new')] }))));
	assert.deepEqual((await catalog.list()).map((info) => info.id), ['openrouter/lab/old'], 'a stale list is served without waiting');
	assert.deepEqual((await catalog.list()).map((info) => info.id), ['openrouter/lab/old']);
	assert.equal(seen.length, 2, 'one refresh at a time');
	land();
	await new Promise((resolve) => setTimeout(resolve, 10));
	answer = () => new Response('down', { status: 500 });
	assert.deepEqual((await catalog.list()).map((info) => info.id), ['openrouter/lab/new']);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual((await catalog.list()).map((info) => info.id), ['openrouter/lab/new'], 'a failed refresh keeps the last good list');
});

const routed: ModelInfo = {
	id: 'openrouter/lab/model',
	name: 'Model',
	vendor: 'Lab',
	description: '',
	createdAt: 0,
	contextLength: 128_000,
	maxOutput: null,
	price: { input: 1, output: 4, cacheRead: 1, cacheWrite: 1 },
	vision: false,
	reasoning: [],
	defaultReasoning: 'off',
};

/** OpenRouter's account with each key it was asked about, and a catalog that counts its listings. */
function fakeGateway() {
	const calls = { check: [] as string[], list: 0 };
	const account: GatewayAccount = {
		id: 'openrouter',
		name: 'OpenRouter',
		gateway: 'openrouter',
		keyPage: 'https://openrouter.ai/settings/keys',
		envVar: 'OPENROUTER_API_KEY',
		check: async (key) => {
			calls.check.push(key);
			if (!key.startsWith('sk-or-good')) throw new Error('OpenRouter did not accept that key.');
			return { email: null };
		},
		windows: async () => [{ label: 'Credits', usedPercent: 10, resetsAt: null, limited: false }],
	};
	const models = {
		name: 'openrouter',
		list: async () => {
			calls.list += 1;
			return [routed];
		},
	};
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models, gatewayAccount: account });
	return calls;
}

test('OpenRouter models are offered only while it has a key, pasted or the server’s', async () => {
	fakeGateway();
	const [before] = await subscriptions.subscriptionsView();
	assert.deepEqual([before.kind, before.state, before.keySource, before.models.length], ['gateway', 'signed-out', null, 0]);
	assert.deepEqual(await listModels(), [], 'no key, no OpenRouter models in the picker');

	config.openrouter.apiKey = 'sk-or-server-9999';
	const fromServer = (await subscriptions.subscriptionsView())[0];
	assert.deepEqual([fromServer.state, fromServer.keySource, fromServer.keyHint, fromServer.envVar], ['connected', 'environment', '9999', 'OPENROUTER_API_KEY']);
	assert.deepEqual(
		fromServer.models.map((model) => [model.id, model.vendor, model.price]),
		[['openrouter/lab/model', 'Lab', { input: 1, output: 4 }]],
	);
	assert.deepEqual(fromServer.windows, [{ label: 'Credits', usedPercent: 10, resetsAt: null, limited: false }]);
	assert.deepEqual((await listModels()).map((model) => model.id), ['openrouter/lab/model'], 'the server’s key still works as it did');
	assert.equal(subscriptions.onPlan('openrouter/lab/model'), false, 'OpenRouter bills per token, not a plan');
});

test('a pasted OpenRouter key is kept once OpenRouter accepts it, wins over the server’s, and gives way to it when removed', async () => {
	const calls = fakeGateway();
	config.openrouter.apiKey = 'sk-or-server-9999';

	await assert.rejects(subscriptions.connectKey('openrouter', 'two words'), /on its own/);
	await assert.rejects(subscriptions.connectKey('openrouter', 'sk-bad'), /did not accept that key/);
	assert.equal(openRouterKeySource(), 'environment', 'a refused key is not kept');

	const listedBefore = calls.list;
	const pasted = await subscriptions.connectKey('openrouter', ' sk-or-good-1234 ');
	assert.deepEqual([pasted.state, pasted.keySource, pasted.keyHint], ['connected', 'settings', '1234']);
	assert.ok(calls.list > listedBefore, 'the models are listed again with the new key');
	assert.equal(openRouterKey(), 'sk-or-good-1234');
	assert.equal(await subscriptions.gatewayKey(), 'sk-or-good-1234');

	// A restart reads the pasted key back before anything calls OpenRouter.
	subscriptions.resetSubscriptionsForTests();
	assert.equal(openRouterKey(), 'sk-or-server-9999');
	await subscriptions.loadGatewayKey();
	assert.equal(openRouterKey(), 'sk-or-good-1234');

	await subscriptions.setSubscriptionOptions('openrouter', { enabled: false, countAtApiPrices: true });
	assert.deepEqual(await listModels(), [], 'switched off, its models leave the picker');
	await subscriptions.setSubscriptionOptions('openrouter', { enabled: true, countAtApiPrices: true });

	const removed = await subscriptions.disconnect('openrouter');
	assert.deepEqual([removed.state, removed.keySource, removed.keyHint], ['connected', 'environment', '9999']);
	assert.equal(openRouterKey(), 'sk-or-server-9999');
	config.openrouter.apiKey = '';
	assert.equal((await subscriptions.disconnect('openrouter')).state, 'signed-out');
	await assert.rejects(subscriptions.beginLogin('openrouter'), /takes a key/);
});

test('an OpenRouter call goes with the key in use at the time', async () => {
	const models = createModels();
	let key: string | null = 'sk-or-first';
	models.setProvider(liveOpenRouterProvider(() => [routed], async () => key));
	const model = models.getModel('openrouter', 'lab/model');
	assert.ok(model, 'a live catalog model resolves under openrouter/');
	const chunk = (body: object) => `data: ${JSON.stringify(body)}\n\n`;
	const seen = stubFetch({
		[`${API}/chat/completions`]: () =>
			new Response(
				[
					chunk({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'lab/model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready.' } }] }),
					chunk({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'lab/model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
					'data: [DONE]\n\n',
				].join(''),
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
	});
	const context = { systemPrompt: 'Be brief.', messages: [{ role: 'user' as const, content: 'Say ready.', timestamp: 0 }] };
	const reply = await models.completeSimple(model, context);
	assert.equal(reply.stopReason, 'stop', reply.errorMessage);
	assert.equal(seen[0].headers.get('authorization'), 'Bearer sk-or-first');
	key = 'sk-or-second';
	await models.completeSimple(model, context);
	assert.equal(seen[1].headers.get('authorization'), 'Bearer sk-or-second', 'a key pasted later needs no restart');
});

test("a model pi knows is priced from OpenRouter's live list, keeping pi's wire settings", () => {
	const models = createModels();
	const live = { ...routed, id: 'openrouter/openai/gpt-5.6-luna', price: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 } };
	models.setProvider(liveOpenRouterProvider(() => [live], async () => 'sk-or-key'));
	const model = models.getModel('openrouter', 'openai/gpt-5.6-luna');
	assert.ok(model, 'pi knows the model');
	assert.deepEqual(model.cost, live.price);
	assert.equal(model.contextWindow, 1_050_000, "pi's own entry, not the live one's");
});
