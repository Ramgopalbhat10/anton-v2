import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { ModelInfo, SubscriptionProvider } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-context-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { compactionReserve, contextView, measureRequest, recordContext, scaleParts } = await import('../src/services/context-usage.ts');
const { recordLatestInput } = await import('../src/services/latest-input.ts');
const { planUsage, recordPlanLimit, resetSubscriptionsForTests } = await import('../src/services/subscriptions.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession, getSessionRecord, addSessionUsage } = await import('../src/db/sessions.ts');
const { setSetting } = await import('../src/db/settings.ts');

const model = (id: string, contextLength: number, maxOutput: number | null): ModelInfo => ({
	id,
	name: id,
	vendor: 'OpenAI',
	description: '',
	createdAt: 0,
	contextLength,
	maxOutput,
	price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	vision: false,
	reasoning: [],
	defaultReasoning: 'off',
});

const plan: SubscriptionProvider = {
	id: 'chatgpt',
	name: 'ChatGPT',
	gateway: 'openai',
	startLogin: () => {
		throw new Error('unused');
	},
	refresh: async (credential) => credential,
	listModels: async () => [],
};

setProviders({
	sandbox: {} as never,
	store: {} as never,
	git: {} as never,
	models: { name: 'openrouter', list: async () => [model('openrouter/openai/gpt-6-luna', 272_000, 128_000), { ...model('openrouter/acme/x', 1000, null), price: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } }] },
	subscriptions: [plan],
});

async function task(id: string) {
	const project = await upsertProject('acme/demo', 'main');
	await insertSession({ id, projectId: project.id, title: 'First question', model: 'openai/gpt-6-luna', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });
}

test('a request is measured in parts: the skills list apart from the rest of the system prompt, and MCP tools apart from the agent’s own', () => {
	const parts = measureRequest({
		systemPrompt: `You are Anton.\n\n## Available Skills\n\n- **review** — Review code\n\n## Available Agents\n\nexplorer`,
		tools: [{ name: 'read_file' }, { name: 'mcp__web__search' }, { name: 'mcp__web__fetch' }],
		messages: [{ role: 'user', content: 'hello there' }],
	});
	assert.ok(parts.skills > 0 && parts.systemPrompt > 0);
	assert.ok(parts.mcpTools > parts.tools, 'two MCP tools against one of its own');
	assert.ok(parts.messages > 0);
	assert.deepEqual(measureRequest({ systemPrompt: 'Plain', messages: [] }).skills, 0);
});

test('the parts are scaled to the count the provider gave, in whole tokens that add up exactly', () => {
	const parts = scaleParts({ messages: 300, tools: 100, systemPrompt: 50, skills: 25, mcpTools: 25 }, 10_001);
	assert.equal(parts.reduce((sum, part) => sum + part.tokens, 0), 10_001);
	assert.equal(parts.find((part) => part.key === 'tools')?.tokens, 2000);
	assert.deepEqual(scaleParts({ messages: 0, tools: 0, systemPrompt: 0, skills: 0, mcpTools: 0 }, 50)[0], { key: 'messages', tokens: 50 });
});

test('room is kept for the next reply as the runtime does: up to 20K, no more than the model writes, a third of a small window', () => {
	assert.equal(compactionReserve(272_000, 128_000), 20_000);
	assert.equal(compactionReserve(272_000, 8_000), 8_000);
	assert.equal(compactionReserve(8_000, 4_096), 2_666);
	assert.equal(compactionReserve(200_000, null), 20_000);
});

test('the main conversation’s last call sets the task’s context; subagents, the reviewer and compaction leave it alone', async () => {
	await task('ctx');
	assert.deepEqual(await contextView('ctx'), { model: null, window: 0, used: 0, autocompactAt: 0, parts: [], at: null, task: { calls: 0, tokens: 0 } });
	const request = { providerId: 'openrouter', requestedModel: 'openai/gpt-6-luna', input: { systemPrompt: 'You are Anton.', tools: [{ name: 'read_file' }], messages: [{ role: 'user', content: 'hi' }] } };
	const base = { instanceId: 'ctx', agentName: 'Coder', session: 'default', purpose: 'agent', turnId: 't1' };
	await recordContext({ type: 'turn_request', ...base, request });
	await recordContext({ type: 'turn', ...base, request, response: { usage: { input: 9000, output: 1000, cacheRead: 2000, cacheWrite: 0, totalTokens: 12_000 } } });
	const view = await contextView('ctx');
	assert.equal(view.model, 'openrouter/openai/gpt-6-luna');
	assert.equal(view.used, 12_000);
	assert.equal(view.window, 272_000);
	assert.equal(view.autocompactAt, 252_000);
	assert.equal(view.parts.reduce((sum, part) => sum + part.tokens, 0), 12_000);
	assert.ok(view.parts.find((part) => part.key === 'messages')!.tokens >= 1000, 'the reply counts with the messages');

	for (const other of [
		{ ...base, session: 'task:default:sub-1', turnId: 't2' },
		{ ...base, taskId: 'sub-1', turnId: 't3' },
		{ ...base, agentName: 'Reviewer', turnId: 't4' },
		{ ...base, purpose: 'compaction', turnId: 't5' },
	]) {
		await recordContext({ type: 'turn_request', ...other, request });
		await recordContext({ type: 'turn', ...other, request, response: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } });
	}
	assert.equal((await contextView('ctx')).used, 12_000);
});

test('the task keeps its latest input from the main conversation, not a subagent’s prompt or a reply', async () => {
	await task('latest');
	const message = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse('2026-10-09T03:07:53Z') });
	await recordLatestInput({ type: 'message_end', instanceId: 'latest', agentName: 'Coder', session: 'default', message: message('Is the app using SQLite?') });
	await recordLatestInput({ type: 'message_end', instanceId: 'latest', agentName: 'Coder', session: 'task:default:x', message: message('Investigate the database layer') });
	await recordLatestInput({ type: 'message_end', instanceId: 'latest', agentName: 'Coder', taskId: 'x', message: message('Run the tests') });
	await recordLatestInput({ type: 'message_end', instanceId: 'latest', agentName: 'Coder', message: { role: 'assistant', content: [{ type: 'text', text: 'Yes' }] } });
	await recordLatestInput({ type: 'message_end', instanceId: 'latest', agentName: 'Reviewer', message: message('Review the pull request') });
	const record = await getSessionRecord('latest');
	assert.equal(record?.lastInput, 'Is the app using SQLite?');
	assert.equal(record?.lastInputAt, '2026-10-09T03:07:53.000Z');
	assert.equal(record?.title, 'First question');
});

test('a plan’s use is counted in tokens by day, priced at OpenRouter’s price when the vendor lists none, and its limit noted', async () => {
	resetSubscriptionsForTests();
	await setSetting('subscription.chatgpt', {
		enabled: true,
		countAtApiPrices: false,
		credential: { access: 'a', refresh: 'r', expiresAt: Date.now() + 3600_000, clientId: 'oaiapp_1', scopes: [], email: null },
		connectedAt: new Date().toISOString(),
		models: [],
		modelsAt: Date.now(),
		problem: null,
		limitHitAt: null,
	});
	await task('planned');
	await addSessionUsage('planned', { inputTokens: 900_000, outputTokens: 100_000, cost: 0 }, new Date(), 'openai/gpt-6-luna', 'p1');
	await addSessionUsage('planned', { inputTokens: 1000, outputTokens: 0, cost: 0.01 }, new Date(), 'openrouter/acme/x', 'p2');
	let [usage] = await planUsage();
	assert.deepEqual(usage.tokens, { today: 1_000_000, week: 1_000_000, month: 1_000_000 });
	assert.equal(usage.calls, 1);
	assert.equal(usage.apiValue, 0, 'OpenRouter lists gpt-6-luna at $0 in this test catalog');
	assert.equal(usage.daily.length, 1);
	assert.equal(usage.usagePage, 'https://chatgpt.com/settings/usage');

	await recordPlanLimit({ type: 'turn', request: { providerId: 'openrouter' }, response: { error: { message: 'subscription_sharing_usage_limit_exceeded' } } });
	assert.equal((await planUsage())[0].limitHitAt, null, 'another gateway’s error is not the plan’s');
	await recordPlanLimit({ type: 'turn', request: { providerId: 'openai' }, response: { error: { message: 'Error: subscription_sharing_usage_limit_exceeded' } } });
	[usage] = await planUsage();
	assert.ok(usage.limitHitAt);
});
