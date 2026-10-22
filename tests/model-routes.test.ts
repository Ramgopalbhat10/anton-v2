import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api, Context, Model, Provider, StreamOptions } from '@earendil-works/pi-ai';
import { asRoute, openRouterRouting, parseRouted, routedId, unrouted, vercelRouting } from '../src/core/model-route.ts';
import { withRoutes } from '../src/flue/live-models.ts';
import { toEndpoints as openRouterEndpoints } from '../src/providers/openrouter/catalog.ts';
import { toCredits, vercelAccount } from '../src/providers/vercel/account.ts';
import { isAgentModel, reasoningLevels, toEndpoints as vercelEndpoints, toModelInfo, type VercelModel } from '../src/providers/vercel/catalog.ts';

test('a route rides on the model specifier and comes off it whole', () => {
	assert.equal(routedId('openrouter/deepseek/deepseek-v3.2', { provider: 'deepinfra/fp4' }), 'openrouter/deepseek/deepseek-v3.2#via=deepinfra/fp4');
	assert.equal(routedId('vercel/anthropic/claude-sonnet-5', { sort: 'price' }), 'vercel/anthropic/claude-sonnet-5#sort=price');
	assert.equal(routedId('vercel/anthropic/claude-sonnet-5', null), 'vercel/anthropic/claude-sonnet-5');
	// A plan's model has no gateway to route it.
	assert.equal(routedId('openai/gpt-5.5', { sort: 'price' }), 'openai/gpt-5.5');

	assert.deepEqual(parseRouted('openrouter/deepseek/deepseek-v3.2#via=deepinfra/fp4'), { model: 'openrouter/deepseek/deepseek-v3.2', route: { provider: 'deepinfra/fp4' } });
	assert.deepEqual(parseRouted('vercel/a/b#sort=latency'), { model: 'vercel/a/b', route: { sort: 'latency' } });
	assert.deepEqual(parseRouted('vercel/a/b#sort=fastest'), { model: 'vercel/a/b', route: null });
	assert.equal(unrouted('openrouter/x/y#sort=price'), 'openrouter/x/y');
	assert.equal(unrouted('openrouter/x/y'), 'openrouter/x/y');

	assert.deepEqual(asRoute({ provider: 'groq' }), { provider: 'groq' });
	assert.deepEqual(asRoute({ sort: 'throughput' }), { sort: 'throughput' });
	assert.equal(asRoute({ sort: 'cheapest' }), null);
	assert.equal(asRoute({ provider: 'a b' }), null);
});

test('each gateway hears the route in its own words, with its fallback kept on', () => {
	assert.deepEqual(openRouterRouting({ provider: 'groq' }), { order: ['groq'], allow_fallbacks: true });
	assert.deepEqual(openRouterRouting({ sort: 'latency' }), { sort: 'latency', allow_fallbacks: true });
	assert.deepEqual(vercelRouting({ provider: 'bedrock' }), { order: ['bedrock'] });
	assert.deepEqual(
		(['price', 'throughput', 'latency'] as const).map((sort) => vercelRouting({ sort })),
		[{ sort: 'cost' }, { sort: 'tps' }, { sort: 'ttft' }],
	);
});

const sonnet: VercelModel = {
	id: 'anthropic/claude-sonnet-5',
	name: 'Claude Sonnet 5',
	description: 'Sonnet 5 is an upgrade to Sonnet 4.6. It builds on its strengths.',
	owned_by: 'anthropic',
	released: 1782691200,
	context_window: 1_000_000,
	max_tokens: 128_000,
	type: 'language',
	tags: ['reasoning', 'tool-use', 'vision'],
	modalities: { input: ['text', 'image'], output: ['text'] },
	reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }, { type: 'budget_tokens' }],
	pricing: { input: '0.000002', output: '0.00001', input_cache_read: '0.0000002', input_cache_write: '0.0000025' },
};

test('a Vercel AI Gateway model maps to the catalog shape', () => {
	const info = toModelInfo(sonnet);
	assert.equal(info.id, 'vercel/anthropic/claude-sonnet-5');
	assert.deepEqual([info.vendor, info.name], ['Anthropic', 'Claude Sonnet 5']);
	assert.equal(info.description, 'Sonnet 5 is an upgrade to Sonnet 4.6.');
	const cents = Object.fromEntries(Object.entries(info.price).map(([key, value]) => [key, Math.round(value * 100) / 100]));
	assert.deepEqual(cents, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
	assert.deepEqual(info.reasoning, ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
	assert.equal(info.defaultReasoning, 'medium');
	assert.equal(info.vision, true);
	assert.equal(info.contextLength, 1_000_000);
	assert.equal(info.createdAt, 1782691200000);
	assert.equal(toModelInfo({ ...sonnet, owned_by: 'spacexai' }).vendor, 'xAI');
});

test('Vercel reasoning levels follow its reasoning options', () => {
	const levels = (reasoning_options: VercelModel['reasoning_options'], tags = ['tool-use', 'reasoning']) => reasoningLevels({ ...sonnet, reasoning_options, tags });
	assert.deepEqual(levels([{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }]), ['minimal', 'low', 'medium', 'high', 'xhigh'], 'no off when it must reason');
	assert.deepEqual(levels([{ type: 'toggle' }]), ['off', 'low', 'medium', 'high']);
	assert.deepEqual(levels([{ type: 'budget_tokens' }]), ['low', 'medium', 'high']);
	assert.deepEqual(levels(null), ['off', 'low', 'medium', 'high']);
	assert.deepEqual(levels(null, ['tool-use']), []);
});

test('only priced, tool-calling language models are offered from Vercel AI Gateway', () => {
	assert.equal(isAgentModel(sonnet), true);
	assert.equal(isAgentModel({ ...sonnet, type: 'image' }), false);
	assert.equal(isAgentModel({ ...sonnet, tags: ['reasoning'] }), false);
	assert.equal(isAgentModel({ ...sonnet, id: 'anthropic/claude-opus-4.6-batch' }), false);
	assert.equal(isAgentModel({ ...sonnet, pricing: null }), false);
});

test('each gateway lists the providers a route can name', () => {
	const vercel = vercelEndpoints({
		data: {
			endpoints: [
				{
					provider_name: 'bedrock',
					context_length: 128000,
					pricing: { prompt: '0.00000062', completion: '0.00000185' },
					supported_parameters: ['tools'],
					uptime_last_1h: 100,
					latency_last_1h: { p50: 997.5 },
					throughput_last_1h: { p50: 14 },
				},
				{ provider_name: 'nocalls', supported_parameters: ['max_tokens'] },
			],
		},
	});
	assert.deepEqual(vercel, [{ slug: 'bedrock', name: 'bedrock', price: { input: 0.62, output: 1.85 }, contextLength: 128000, latency: 0.9975, throughput: 14, uptime: 100 }]);

	const openRouter = openRouterEndpoints({
		data: {
			endpoints: [
				{ provider_name: 'DeepInfra', tag: 'deepinfra/fp4', context_length: 163840, pricing: { prompt: '0.00000026', completion: '0.00000038' }, supported_parameters: ['tools'], uptime_last_30m: 99.5, latency_last_30m: null },
			],
		},
	});
	assert.deepEqual(openRouter, [{ slug: 'deepinfra/fp4', name: 'DeepInfra', price: { input: 0.26, output: 0.38 }, contextLength: 163840, latency: null, throughput: null, uptime: 99.5 }]);
});

test("Vercel's credits read as how much is spent, and a refused key says where to make one", async () => {
	assert.deepEqual(toCredits({ balance: '95.50', total_used: '4.50' }), { label: 'Credits · $95.50 left', usedPercent: 4.5, resetsAt: null, limited: false });
	assert.equal(toCredits({}), null);
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
	try {
		await assert.rejects(() => vercelAccount({ apiUrl: 'https://gateway.test' }).check('bad'), /API Keys/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('a routed model resolves to its model, and its calls carry the route in the request body', async () => {
	const model = { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek', api: 'openai-completions', provider: 'openrouter' } as Model<Api>;
	const sent: Array<{ id: string; payload: unknown }> = [];
	const base = {
		id: 'openrouter',
		getModels: () => [model],
		stream: () => {
			throw new Error('unused');
		},
		streamSimple: (called: Model<Api>, _context: Context, options?: StreamOptions) => {
			// The API module builds the body, then hands it to onPayload.
			void Promise.resolve(options?.onPayload?.({ model: called.id, messages: [] }, called)).then((payload) => sent.push({ id: called.id, payload }));
			return undefined as never;
		},
	} as unknown as Provider;
	const routed = withRoutes(base, () => ['openrouter/deepseek/deepseek-v3.2#via=groq', 'vercel/other#sort=price'], (payload, route) => ({ ...payload, provider: openRouterRouting(route) }));

	assert.deepEqual(
		routed.getModels().map((entry) => entry.id),
		['deepseek/deepseek-v3.2', 'deepseek/deepseek-v3.2#via=groq'],
	);
	const pick = routed.getModels().find((entry) => entry.id.endsWith('#via=groq'))!;
	routed.streamSimple(pick, { messages: [] });
	routed.streamSimple(model, { messages: [] });
	await new Promise((resolve) => setImmediate(resolve));
	// The plain model goes out as it was; the routed one as the same model, with the route.
	assert.deepEqual(
		sent.map((call) => call.id),
		['deepseek/deepseek-v3.2', 'deepseek/deepseek-v3.2'],
	);
	assert.deepEqual(
		sent.map((call) => call.payload).filter(Boolean),
		[{ model: 'deepseek/deepseek-v3.2', messages: [], provider: { order: ['groq'], allow_fallbacks: true } }],
	);
});
