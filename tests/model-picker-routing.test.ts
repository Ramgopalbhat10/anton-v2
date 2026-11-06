import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createClient } from '@libsql/client';
import type { GitHost, ModelInfo } from '../src/core/ports.ts';
import { routeForModel, validModelSpecifier } from '../src/core/model-route.ts';
import { registeredRoutedModels } from '../src/core/routed-models.ts';
import { openRouterText } from '../src/providers/openrouter/text.ts';
import { openRouterVision } from '../src/providers/openrouter/vision.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-picker-routes-'));
process.env.ANTON_DATA_DIR = path.join(dir, 'data');
after(() => rmSync(dir, { recursive: true, force: true }));
const { useDatabase } = await import('../src/db/client.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { generalSettings, setGeneralSettings, backgroundModel } = await import('../src/services/general.ts');
const { createSession, editSession, primeModel, agentModelFor, routedModels, fallbackModel, switchToFallbackModel } = await import('../src/services/sessions.ts');
const { primeAgent, helperModelFor, setAgentDelivery } = await import('../src/services/agent-runner.ts');
const { createSpace, editSpace, startThread } = await import('../src/services/spaces.ts');
const { primeCoordinator, coordinatorBrief } = await import('../src/services/coordinator.ts');
const { compactionFor } = await import('../src/services/context-usage.ts');
const { findModel } = await import('../src/services/models.ts');
const { addAutomation } = await import('../src/services/automations.ts');
const { visionModelFor } = await import('../src/services/vision.ts');

const model = (id: string, vision = true): ModelInfo => ({ id, name: id, vendor: 'Test', description: '', createdAt: 0, contextLength: 128000, maxOutput: null, price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, vision, reasoning: ['low', 'high'], defaultReasoning: 'high' });
const first = 'openrouter/test/first';
const second = 'openrouter/test/second';
const vercel = 'vercel/test/model';
useDatabase(createClient({ url: `file:${path.join(dir, 'test.db')}` }));
setProviders({ git: {} as GitHost, sandbox: localSandboxProvider(dir), store: diskStore(path.join(dir, 'objects')), vision: { runs: (model) => model.startsWith('openrouter/'), look: async () => { throw new Error('not called'); } }, models: { name: 'fake', list: async () => [model(first), model(second, false), model(vercel)] } });
setAgentDelivery(async () => undefined);

// Canonical validation protects every string-backed caller without widening its catalog/filter.
test('stored routes are canonical, gateway-only and subject to the same model/capability checks', async () => {
	for (const id of [`${first}#sort=price`, `${vercel}#via=bedrock`, `${first}[1m]#sort=latency`, first]) assert.equal(validModelSpecifier(id), true, id);
	for (const id of [`${first}#sort=fastest`, `${first}#via=a b`, `${first}#via=groq#sort=price`, 'openai/model#sort=price', `${first}#unknown=x`, `${first}#via=groq=extra`]) {
		assert.equal(validModelSpecifier(id), false, id);
		assert.equal(await findModel(id), undefined);
	}
	assert.equal((await findModel(`${first}#via=groq`))?.vision, true);
	const before = await generalSettings();
	await assert.rejects(() => setGeneralSettings({ ...before, backgroundModels: { ...before.backgroundModels, vision: `${second}#sort=price` } }), /does not read images/);
	await assert.rejects(() => setGeneralSettings({ ...before, titleModel: `${vercel}#sort=price` }), /OpenRouter model/);
	assert.deepEqual(routeForModel({ provider: 'groq' }, first, second), null);
	assert.deepEqual(routeForModel({ sort: 'price' }, first, vercel), { sort: 'price' });
	assert.deepEqual(routeForModel({ sort: 'price' }, first, 'openai/plan'), null);
});

test('defaults, projects, helpers, coordinators, background work and automations retain independent routed choices', async () => {
	const before = await generalSettings();
	try {
		const settings = { ...before, model: `${first}#via=groq`, reasoning: 'low' as const,
			titleModel: `${second}#sort=price`,
			agentModels: { ...before.agentModels, tester: { model: `${vercel}#sort=throughput`, reasoning: 'low' as const } },
			backgroundModels: { webDigest: `${second}#via=deepinfra`, vision: `${first}#sort=latency`, compaction: `${second}#sort=price` },
			backgroundReasoning: { ...before.backgroundReasoning, compaction: 'low' as const } };
		await setGeneralSettings(settings);
		assert.deepEqual(await generalSettings(), settings);
		const task = await createSession({ title: 'Default' });
		assert.deepEqual([task.model, task.route, task.reasoning], [first, { provider: 'groq' }, 'low']);
		const clear = await createSession({ route: null });
		assert.equal(clear.route, null, 'an explicit clear wins over the inherited default');
		const override = await createSession({ model: `${second}#sort=price` });
		assert.deepEqual([override.model, override.route, override.reasoning], [second, { sort: 'price' }, null]);
		await primeModel(task.id);
		assert.equal(agentModelFor(task.id).model, settings.model);
		assert.equal(await fallbackModel(task.id), null);
		assert.equal((await switchToFallbackModel(override.id)).model, first);
		assert.deepEqual((await switchToFallbackModel(clear.id)).route, { provider: 'groq' });
		assert.equal((await editSession(task.id, { model: `${second}#sort=latency` })).model, second);

		const space = await createSpace({ name: 'Independent' });
		await editSpace(space.id, { coordinatorModel: `${second}#via=deepinfra`, coordinatorReasoning: 'low', threadModel: `${vercel}#sort=latency`, threadReasoning: 'high', agentModels: { ...before.agentModels, computer: { model: `${first}#via=fireworks`, reasoning: 'low' } } });
		await primeCoordinator(space.id);
		assert.equal(coordinatorBrief(space.id).model, `${second}#via=deepinfra`);
		assert.equal(coordinatorBrief(space.id).reasoning, 'low');
		const thread = await startThread(space.id, { title: 'Thread', brief: 'Work' });
		assert.deepEqual([thread.model, thread.route, thread.reasoning], [vercel, { sort: 'latency' }, 'high']);
		await primeAgent(thread.id, { warm: false });
		await primeAgent(task.id, { warm: false });
		assert.equal(helperModelFor(thread.id, 'computer')?.model, `${first}#via=fireworks`);
		assert.equal(helperModelFor(task.id, 'computer'), null, 'no project helper route leaks into a loose task');
		assert.equal(helperModelFor(thread.id, 'tester')?.model, `${vercel}#sort=throughput`);
		assert.equal(visionModelFor(thread.id), `${first}#via=fireworks`, 'routed helper retains its vision capability and route');
		assert.equal(visionModelFor(task.id), `${first}#sort=latency`, 'a blind task uses its independently routed background choice');
		assert.deepEqual(compactionFor(first)?.model, `${second}#sort=price`);
		assert.deepEqual(compactionFor(first)?.reasoning, 'low');
		assert.equal(backgroundModel('webDigest'), `${second}#via=deepinfra`);
		const automation = await addAutomation(null, { spaceId: space.id, kind: 'schedule', prompt: 'Work', schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC' }, model: `${first}#sort=throughput`, reasoning: 'low' });
		assert.equal(automation.model, `${first}#sort=throughput`);
		const run = await createSession({ model: automation.model!, reasoning: automation.reasoning ?? undefined });
		assert.deepEqual([run.model, run.route, run.reasoning], [first, { sort: 'throughput' }, 'low']);
		for (const spec of [settings.agentModels.tester!.model, settings.backgroundModels.compaction, `${second}#via=deepinfra`, `${first}#via=fireworks`]) assert.ok(routedModels().includes(spec), spec);
		await setGeneralSettings(before);
		assert.ok(!registeredRoutedModels().includes(settings.backgroundModels.compaction), 'replacing the background scope removes its old specifiers');
	} finally { await setGeneralSettings(before); }
});

test('direct OpenRouter text and vision calls send plain model IDs and provider preferences, retaining effort and fallbacks', async () => {
	const original = globalThis.fetch;
	const sent: Array<Record<string, any>> = [];
	globalThis.fetch = (async (_url, init) => {
		sent.push(JSON.parse(String(init?.body)));
		return new Response(JSON.stringify({ choices: [{ message: { content: 'Answer' } }], usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.01 } }));
	}) as typeof fetch;
	try {
		const text = openRouterText({ apiUrl: 'https://example.test', apiKey: 'test' });
		const vision = openRouterVision({ apiUrl: 'https://example.test', apiKey: 'test' });
		await text.write({ model: `${first}#via=groq`, prompt: 'Hi', maxTokens: 10, reasoning: 'low' });
		await vision.look({ model: `${first}#sort=latency`, prompt: 'Look', image: new Uint8Array([1]), mimeType: 'image/png', reasoning: 'high' });
		await text.write({ model: first, prompt: 'Plain', maxTokens: 10 });
		assert.deepEqual(sent.map((body) => body.model), [first.slice('openrouter/'.length), first.slice('openrouter/'.length), first.slice('openrouter/'.length)]);
		assert.deepEqual(sent.map((body) => body.provider), [{ order: ['groq'], allow_fallbacks: true }, { sort: 'latency', allow_fallbacks: true }, undefined]);
		assert.deepEqual(sent.map((body) => body.reasoning), [{ effort: 'low' }, { effort: 'high' }, undefined]);
	} finally { globalThis.fetch = original; }
});
