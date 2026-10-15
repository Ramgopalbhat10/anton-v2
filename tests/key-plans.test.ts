import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { KeyPlan, ModelInfo, SubscriptionModel } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-key-plans-'));
process.env.ANTON_DATA_DIR = dir;

const { openCodeGoPlan, toSubscriptionModel, toWindows, nameOf } = await import('../src/providers/opencode-go/plan.ts');
const { apiFor, openCodeGoProvider, SESSION_HEADER } = await import('../src/flue/opencode-go-models.ts');
const { setProviders } = await import('../src/providers/index.ts');
const subscriptions = await import('../src/services/subscriptions.ts');
const { listModels } = await import('../src/services/models.ts');
const { createModels } = await import('@earendil-works/pi-ai');

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
	subscriptions.resetSubscriptionsForTests();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	globalThis.fetch = realFetch;
	subscriptions.resetSubscriptionsForTests();
	const { appDb } = await import('../src/db/client.ts');
	await (await appDb()).execute("DELETE FROM settings WHERE key LIKE 'subscription%'");
});

const GO = 'https://opencode.ai/inference/go/v1';
const usage = {
	usage: {
		rolling: { status: 'ok', resetInSec: 3600, percent: 12.5, resetsAt: '2026-10-15T18:00:00Z' },
		weekly: { status: 'rate-limited', resetInSec: 86400, percent: 100, resetsAt: null },
		monthly: { status: 'ok', percent: 40 },
	},
};

test('OpenCode Go lists the plan’s models, filled in from pi where it knows them, and leaves out Gemini', async () => {
	const seen = stubFetch({
		[`${GO}/models`]: () => Response.json({ object: 'list', data: [{ id: 'glm-5.1' }, { id: 'gemini-3-pro' }, { id: 'glm-9-flash' }, { id: 'glm-5.1' }] }),
	});
	const models = await openCodeGoPlan().listModels('sk-go');
	assert.deepEqual(
		models.map((model) => model.id),
		['opencode-go/glm-5.1', 'opencode-go/glm-9-flash'],
	);
	const known = models[0];
	assert.ok(known.contextLength > 0);
	assert.ok(known.listPrice, 'pi’s prices are what the caps count at');
	const unknown = models[1];
	assert.equal(unknown.name, 'GLM-9 Flash');
	assert.equal(unknown.vendor, 'Z.ai');
	assert.deepEqual(unknown.reasoning, [], 'a model pi does not know gets no effort it might refuse');
	assert.equal(unknown.listPrice, null);
	assert.equal(seen[0].headers.get('authorization'), 'Bearer sk-go');
	assert.equal(seen[0].headers.get('x-opencode-client'), 'anton');
	assert.equal(seen[0].headers.get('user-agent'), 'anton');
});

test('OpenCode Go checks a key against the plan’s usage, and reads its limits from it', async () => {
	stubFetch({
		[`${GO}/usage`]: (request) =>
			request.headers.get('authorization') === 'Bearer sk-good'
				? Response.json(usage)
				: request.headers.get('authorization') === 'Bearer sk-free'
					? new Response('no plan', { status: 403 })
					: new Response('bad key', { status: 401 }),
	});
	const plan = openCodeGoPlan();
	assert.deepEqual(await plan.check('sk-good'), { email: null });
	await assert.rejects(plan.check('sk-bad'), /did not accept that key/);
	await assert.rejects(plan.check('sk-free'), /no OpenCode Go subscription/);
	assert.deepEqual(await plan.windows!('sk-good'), [
		{ label: '5 hours', usedPercent: 12.5, resetsAt: '2026-10-15T18:00:00Z', limited: false },
		{ label: 'Week', usedPercent: 100, resetsAt: null, limited: true },
		{ label: 'Month', usedPercent: 40, resetsAt: null, limited: false },
	]);
	assert.deepEqual(toWindows({}), []);
	assert.deepEqual(toWindows(null), []);
});

test('OpenCode Go names unknown models readably and routes each family to the API OpenCode serves it on', () => {
	assert.equal(nameOf('kimi-k3'), 'Kimi K3');
	assert.equal(nameOf('qwen3.8-max'), 'Qwen3.8 Max');
	assert.equal(apiFor('claude-sonnet-5'), 'anthropic-messages');
	assert.equal(apiFor('minimax-m3'), 'anthropic-messages');
	assert.equal(apiFor('gpt-6-codex'), 'openai-responses');
	assert.equal(apiFor('some-new-model'), 'openai-completions');
	assert.equal(toSubscriptionModel('glm-5.1').id, 'opencode-go/glm-5.1');
});

const glm: ModelInfo = {
	id: 'opencode-go/glm-9-flash',
	name: 'GLM-9 Flash',
	vendor: 'Z.ai',
	description: '',
	createdAt: 0,
	contextLength: 200_000,
	maxOutput: null,
	price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	vision: false,
	reasoning: [],
	defaultReasoning: 'off',
	subscription: 'OpenCode Go',
};

const chunk = (body: object) => `data: ${JSON.stringify(body)}\n\n`;

test('an OpenCode Go call sends the key, Anton’s name and the conversation’s session id', async () => {
	const models = createModels();
	models.setProvider(openCodeGoProvider(() => [glm, { ...glm, id: 'openrouter/z-ai/glm-9-flash' }], async () => 'sk-go'));
	const model = models.getModel('opencode-go', 'glm-9-flash');
	assert.ok(model, 'the plan model resolves under opencode-go/');
	const seen = stubFetch({
		[`${GO}/chat/completions`]: () =>
			new Response(
				[
					chunk({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'glm-9-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready.' } }] }),
					chunk({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'glm-9-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
					'data: [DONE]\n\n',
				].join(''),
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
	});
	const context = { systemPrompt: 'Be brief.', messages: [{ role: 'user' as const, content: 'Say ready.', timestamp: 0 }] };
	const reply = await models.completeSimple(model, context, { sessionId: 'task-1' });
	assert.equal(reply.stopReason, 'stop', reply.errorMessage);
	assert.deepEqual(reply.content, [{ type: 'text', text: 'Ready.' }]);
	assert.equal(seen[0].headers.get('authorization'), 'Bearer sk-go');
	assert.equal(seen[0].headers.get(SESSION_HEADER), 'task-1');
	assert.equal(seen[0].headers.get('x-opencode-client'), 'anton');

	await models.completeSimple(model, context);
	assert.match(seen[1].headers.get(SESSION_HEADER) ?? '', /^anton-[0-9a-f-]{36}$/, 'a call outside a conversation gets a session of its own');
});

/** A key plan with every call to the vendor recorded. */
function fakeKeyPlan() {
	const calls = { check: [] as string[], list: 0, windows: 0 };
	const model: SubscriptionModel = { ...toSubscriptionModel('glm-5.1'), listPrice: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 } };
	const plan: KeyPlan = {
		id: 'opencode-go',
		name: 'OpenCode Go',
		gateway: 'opencode-go',
		keyPage: 'https://opencode.ai/auth',
		check: async (key) => {
			calls.check.push(key);
			if (key !== 'sk-good-1234') throw new Error('OpenCode did not accept that key.');
			return { email: null };
		},
		listModels: async () => {
			calls.list += 1;
			return [model];
		},
		windows: async () => {
			calls.windows += 1;
			return [{ label: '5 hours', usedPercent: 30, resetsAt: null, limited: false }];
		},
	};
	return { plan, calls };
}

test('a key is kept only once the vendor accepts it; its plan then offers its models and its limits', async () => {
	const { plan, calls } = fakeKeyPlan();
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, keyPlans: [plan] });

	const [before] = await subscriptions.subscriptionsView();
	assert.deepEqual([before.kind, before.state, before.keyPage, before.keyHint], ['key', 'signed-out', 'https://opencode.ai/auth', null]);
	await assert.rejects(subscriptions.planKey('opencode-go'), /not connected/);
	assert.equal(await subscriptions.planRuntime('opencode-go'), undefined, 'a plan with no agent of its own is called directly');

	await assert.rejects(subscriptions.connectKey('opencode-go', 'two words'), /on its own/);
	await assert.rejects(subscriptions.connectKey('opencode-go', 'sk-bad'), /did not accept that key/);
	assert.equal((await subscriptions.subscriptionsView())[0].state, 'signed-out');
	await assert.rejects(subscriptions.connectKey('cursor', 'sk-good-1234'), /takes a key/);

	const connected = await subscriptions.connectKey('opencode-go', '  sk-good-1234 ');
	assert.deepEqual(calls.check, ['sk-bad', 'sk-good-1234']);
	assert.equal(connected.state, 'connected');
	assert.equal(connected.keyHint, '1234');
	assert.deepEqual(
		connected.models.map((model) => model.id),
		['opencode-go/glm-5.1'],
	);
	assert.deepEqual(connected.windows, [{ label: '5 hours', usedPercent: 30, resetsAt: null, limited: false }]);
	assert.equal(await subscriptions.planKey('opencode-go'), 'sk-good-1234');
	assert.equal(JSON.stringify(connected).includes('sk-good'), false, 'the key itself never leaves the server');

	const [listed] = await listModels();
	assert.equal(listed.id, 'opencode-go/glm-5.1');
	assert.equal(listed.subscription, 'OpenCode Go');
	assert.equal(listed.price.output, 0);
	await subscriptions.setSubscriptionOptions('opencode-go', { enabled: true, countAtApiPrices: true });
	assert.equal((await listModels())[0].price.output, 3);
	assert.equal(calls.list, 1, 'the list is reused within the hour');

	await subscriptions.subscriptionsView();
	assert.equal(calls.windows, 1, 'the limits are asked again only after a minute');

	const gone = await subscriptions.disconnect('opencode-go');
	assert.deepEqual([gone.state, gone.keyHint, gone.models.length], ['signed-out', null, 0]);
	await assert.rejects(subscriptions.planKey('opencode-go'), /not connected/);
	assert.deepEqual(await listModels(), []);
});
