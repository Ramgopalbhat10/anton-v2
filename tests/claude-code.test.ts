import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentRuntime, AgentRuntimeStatus, ModelInfo, RuntimeContent, RuntimeConversationOptions, RuntimeEvent, RuntimeToolOutput, SubscriptionModel } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-claude-code-'));
process.env.ANTON_DATA_DIR = dir;

const { childEnv, isExtraUsageNotice, statusFrom, toModels, toRuntimeEvents, toWindows } = await import('../src/providers/claude-code/runtime.ts');
const { claudeCodeProvider, closeClaudeCodeConversations, continuation, fingerprint, transcript } = await import('../src/flue/claude-code-models.ts');
const { setProviders } = await import('../src/providers/index.ts');
const subscriptions = await import('../src/services/subscriptions.ts');
const { listModels } = await import('../src/services/models.ts');
const { createModels } = await import('@earendil-works/pi-ai');

after(() => {
	closeClaudeCodeConversations();
	subscriptions.resetSubscriptionsForTests();
	rmSync(dir, { recursive: true, force: true });
});

/** A queue the fake Claude Code's events are read from. */
function queue<T>() {
	const items: T[] = [];
	let waiting: ((result: IteratorResult<T>) => void) | null = null;
	let closed = false;
	return {
		push(...more: T[]) {
			for (const item of more) {
				if (waiting) {
					const wake = waiting;
					waiting = null;
					wake({ value: item, done: false });
				} else items.push(item);
			}
		},
		close() {
			closed = true;
			waiting?.({ value: undefined, done: true });
		},
		[Symbol.asyncIterator]: () => ({
			next: (): Promise<IteratorResult<T>> =>
				items.length ? Promise.resolve({ value: items.shift()!, done: false }) : closed ? Promise.resolve({ value: undefined, done: true }) : new Promise((resolve) => (waiting = resolve)),
		}),
	};
}

type FakeConversation = {
	options: RuntimeConversationOptions;
	sent: RuntimeContent[][];
	events: ReturnType<typeof queue<RuntimeEvent>>;
	closed: boolean;
	/** What Claude Code does after a tool_use block: call the tool on Anton's MCP server. */
	callTool(id: string, name: string): Promise<RuntimeToolOutput>;
};

/** Claude Code as Anton's bridge sees it, with each conversation it opens kept for the test to drive. */
function fakeRuntime(status: Partial<AgentRuntimeStatus> = {}, models: SubscriptionModel[] = []) {
	const opened: FakeConversation[] = [];
	const calls = { status: 0, list: 0 };
	const runtime: AgentRuntime = {
		id: 'claude',
		name: 'Claude',
		gateway: 'claude-code',
		signInCommand: 'CLAUDE_CONFIG_DIR=/data/claude-code /opt/claude auth login',
		status: async () => {
			calls.status += 1;
			return { signedIn: true, email: 'ada@example.com', plan: 'max', version: '2.5.0', problem: null, ...status };
		},
		listModels: async () => {
			calls.list += 1;
			return models;
		},
		open(options) {
			const events = queue<RuntimeEvent>();
			const conversation: FakeConversation = {
				options,
				sent: [],
				events,
				closed: false,
				callTool: (id, name) => options.callTool(id, name),
			};
			opened.push(conversation);
			return {
				send: (content) => conversation.sent.push(content),
				events,
				close: () => {
					conversation.closed = true;
					events.close();
				},
			};
		},
	};
	return { runtime, opened, calls };
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const say = (text: string, id = 'msg_1'): RuntimeEvent[] => [
	{ type: 'message_start', id, usage: { ...usage, input: 1000, cacheRead: 4000 } },
	{ type: 'block_start', index: 0, block: { type: 'text' } },
	{ type: 'block_delta', index: 0, text },
	{ type: 'block_stop', index: 0 },
	{ type: 'message_delta', stopReason: 'end_turn', usage: { output: 20 } },
	{ type: 'message_stop' },
];
const callTools = (...calls: Array<[id: string, name: string, args: object]>): RuntimeEvent[] => [
	{ type: 'message_start', id: 'msg_t', usage: { ...usage, input: 10 } },
	...calls.flatMap(([id, name, args], index): RuntimeEvent[] => [
		{ type: 'block_start', index, block: { type: 'tool_use', id, name } },
		{ type: 'block_delta', index, json: JSON.stringify(args).slice(0, 5) },
		{ type: 'block_delta', index, json: JSON.stringify(args).slice(5) },
		{ type: 'block_stop', index },
	]),
	{ type: 'message_delta', stopReason: 'tool_use', usage: { output: 5 } },
	{ type: 'message_stop' },
];

const opus: ModelInfo = {
	id: 'claude-code/claude-opus-5',
	name: 'Claude Opus 5',
	vendor: 'Anthropic',
	description: '',
	createdAt: 0,
	contextLength: 200_000,
	maxOutput: 128_000,
	price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	vision: true,
	reasoning: ['off', 'low', 'medium', 'high', 'max'],
	defaultReasoning: 'high',
	subscription: 'Claude',
};

function bridge(runtime: AgentRuntime | undefined, hooks: Parameters<typeof claudeCodeProvider>[2] = {}) {
	const models = createModels();
	models.setProvider(claudeCodeProvider(() => [opus, { ...opus, id: 'openrouter/anthropic/claude-opus-5' }], () => runtime, hooks));
	const model = models.getModel('claude-code', 'claude-opus-5');
	assert.ok(model, 'the plan model resolves under claude-code/');
	return { models, model };
}

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 });
const toolResult = (id: string, name: string, text: string): Message => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false, timestamp: 0 });
const readTool = { name: 'read', description: 'Reads a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } as never;

beforeEach(() => closeClaudeCodeConversations());

test('a plain answer streams through, with the model, effort, instructions and tools Claude Code is opened with', async () => {
	const fake = fakeRuntime();
	const { models, model } = bridge(fake.runtime);
	const reply = models.streamSimple(model, { systemPrompt: 'Be Anton.', messages: [user('Say ready.')], tools: [readTool] }, { sessionId: 's1', reasoning: 'minimal' });
	await new Promise((resolve) => setImmediate(resolve));
	const [conversation] = fake.opened;
	assert.equal(conversation.options.model, 'claude-opus-5');
	assert.equal(conversation.options.instructions, 'Be Anton.');
	assert.equal(conversation.options.effort, 'low', 'minimal has no counterpart and runs at low');
	assert.deepEqual(
		conversation.options.tools.map((tool) => [tool.name, tool.inputSchema.required]),
		[['read', ['path']]],
	);
	assert.deepEqual(conversation.sent, [[{ type: 'text', text: 'Say ready.' }]]);
	conversation.events.push(...say('Ready.'));
	const deltas: string[] = [];
	for await (const event of reply) if (event.type === 'text_delta') deltas.push(event.delta);
	const message = await reply.result();
	assert.equal(message.stopReason, 'stop', message.errorMessage);
	assert.deepEqual(deltas, ['Ready.']);
	assert.deepEqual(message.content, [{ type: 'text', text: 'Ready.' }]);
	assert.deepEqual([message.usage.input, message.usage.cacheRead, message.usage.output, message.usage.totalTokens], [1000, 4000, 20, 5020]);
	assert.ok(message.usage.cost.total > 0, 'calls are priced at API rates; the plan decides whether that counts');
});

test('tool calls end the step; the next step hands Claude Code their results and the same conversation streams on', async () => {
	const fake = fakeRuntime();
	const { models, model } = bridge(fake.runtime);
	const context = { systemPrompt: 'Be Anton.', messages: [user('Read both files.')], tools: [readTool] };
	const first = models.streamSimple(model, context, { sessionId: 's2', reasoning: 'high' });
	await new Promise((resolve) => setImmediate(resolve));
	const [conversation] = fake.opened;
	conversation.events.push(
		...callTools(['tu_a', 'read', { path: 'a.ts' }], ['tu_b', 'read', { path: 'b.ts' }]),
		...say('Both read.', 'msg_2'),
		{ type: 'turn_end' },
		...say('Hello again.', 'msg_3'),
	);
	const step1 = await first.result();
	assert.equal(step1.stopReason, 'toolUse', step1.errorMessage);
	assert.deepEqual(
		step1.content.map((block) => (block.type === 'toolCall' ? [block.id, block.name, block.arguments] : block.type)),
		[
			['tu_a', 'read', { path: 'a.ts' }],
			['tu_b', 'read', { path: 'b.ts' }],
		],
	);

	// Claude Code calls one tool before the next step and waits on it; the other it asks for after the result is in.
	const a = conversation.callTool('tu_a', 'read');
	const messages = [...context.messages, step1, toolResult('tu_a', 'read', 'A'), toolResult('tu_b', 'read', 'B')];
	const step2 = await models.completeSimple(model, { ...context, messages }, { sessionId: 's2', reasoning: 'high' });
	assert.equal(step2.stopReason, 'stop', step2.errorMessage);
	assert.deepEqual(await a, { content: [{ type: 'text', text: 'A' }], isError: false });
	assert.deepEqual(await conversation.callTool('tu_b', 'read'), { content: [{ type: 'text', text: 'B' }], isError: false });
	assert.equal(conversation.sent.length, 1, 'results go to the MCP calls, not as a message');

	// The user's next message goes to the same conversation; the last turn's end is skipped over.
	const step3 = await models.completeSimple(model, { ...context, messages: [...messages, step2, user('Hi.')] }, { sessionId: 's2', reasoning: 'high' });
	assert.equal(step3.stopReason, 'stop', step3.errorMessage);
	assert.deepEqual(step3.content, [{ type: 'text', text: 'Hello again.' }]);
	assert.equal(fake.opened.length, 1);
	assert.deepEqual(conversation.sent[1], [{ type: 'text', text: 'Hi.' }]);
});

test('a context that does not extend the last one starts a new conversation with the conversation so far', async () => {
	const fake = fakeRuntime();
	const { models, model } = bridge(fake.runtime);
	const first = models.completeSimple(model, { messages: [user('One.')] }, { sessionId: 's3' });
	await new Promise((resolve) => setImmediate(resolve));
	fake.opened[0].events.push(...say('First.'));
	const step1 = await first;
	assert.equal(fake.opened[0].options.effort, 'off', 'no reasoning level means thinking off');

	// Flue compacted, so the history it sends is not what this conversation saw.
	const second = models.completeSimple(model, { messages: [user('Summary of earlier work.'), step1, user('Two.')] }, { sessionId: 's3', reasoning: 'max' });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fake.opened.length, 2);
	assert.ok(fake.opened[0].closed, 'the old conversation is closed');
	const [intro, latest] = fake.opened[1].sent[0];
	assert.ok(intro.type === 'text' && intro.text.includes('<conversation_so_far>') && intro.text.includes('[assistant]\nFirst.'));
	assert.deepEqual(latest, { type: 'text', text: 'Two.' });
	assert.equal(fake.opened[1].options.effort, 'max');
	fake.opened[1].events.push(...say('Second.'));
	assert.equal((await second).stopReason, 'stop');
});

test('a plan limit, an extra-usage notice, an early turn end and an abort are each reported and close the conversation', async () => {
	const fake = fakeRuntime();
	const noted = { limit: 0, extra: 0 };
	const { models, model } = bridge(fake.runtime, { onLimit: () => noted.limit++, onExtraUsage: () => noted.extra++ });

	const limited = models.completeSimple(model, { messages: [user('One.')] }, { sessionId: 's4' });
	await new Promise((resolve) => setImmediate(resolve));
	fake.opened[0].events.push({ type: 'extra_usage' }, { type: 'error', message: "You've hit your limit · resets 5pm", limit: true });
	const failed = await limited;
	assert.equal(failed.stopReason, 'error');
	assert.equal(failed.errorMessage, "Claude plan limit reached: You've hit your limit · resets 5pm");
	assert.deepEqual(noted, { limit: 1, extra: 1 });
	assert.ok(fake.opened[0].closed);

	const early = models.completeSimple(model, { messages: [user('Two.')] }, { sessionId: 's5' });
	await new Promise((resolve) => setImmediate(resolve));
	fake.opened[1].events.push({ type: 'turn_end' });
	assert.match((await early).errorMessage ?? '', /ended the turn without answering/);

	const controller = new AbortController();
	const aborted = models.completeSimple(model, { messages: [user('Three.')] }, { sessionId: 's6', signal: controller.signal });
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	assert.equal((await aborted).stopReason, 'aborted');
	assert.ok(fake.opened[2].closed);

	const missing = bridge(undefined);
	assert.match((await missing.models.completeSimple(missing.model, { messages: [user('Hi.')] })).errorMessage ?? '', /not set up/);
});

test('only so many conversations stay open; the longest idle closes first', async () => {
	const fake = fakeRuntime();
	const { models, model } = bridge(fake.runtime, { maxOpen: 2 });
	for (const session of ['m1', 'm2', 'm3']) {
		const reply = models.completeSimple(model, { messages: [user(session)] }, { sessionId: session });
		await new Promise((resolve) => setImmediate(resolve));
		fake.opened.at(-1)!.events.push(...say('ok'));
		await reply;
	}
	assert.deepEqual(
		fake.opened.map((conversation) => conversation.closed),
		[true, false, false],
	);
});

test('the bridge recognises the messages it saw, and tells results and new messages from a changed history', () => {
	const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }, { type: 'toolCall', id: 'tu_1', name: 'read', arguments: {} }], responseId: 'x' } as unknown as Message;
	assert.equal(fingerprint(assistant), fingerprint({ ...assistant, responseId: 'y' } as Message));
	assert.match(fingerprint(assistant), /^a:x:.+,t:tu_1$/);
	assert.equal(fingerprint(toolResult('tu_1', 'read', 'A')), 'r:tu_1');

	assert.deepEqual(continuation([toolResult('tu_1', 'read', 'A')], new Set(['tu_1']))?.user, []);
	assert.equal(continuation([toolResult('tu_1', 'read', 'A')], new Set(['tu_1', 'tu_2'])), null, 'every awaited result must be there');
	assert.equal(continuation([toolResult('tu_9', 'read', 'A')], new Set()), null);
	assert.deepEqual(continuation([user('Next.')], new Set())?.user, [{ type: 'text', text: 'Next.' }]);
	assert.equal(continuation([assistant], new Set()), null);

	assert.deepEqual(transcript([user('Only.')]), [{ type: 'text', text: 'Only.' }]);
	const midTurn = transcript([user('Go.'), assistant, toolResult('tu_1', 'read', 'A')]);
	assert.equal(midTurn.length, 2);
	assert.ok(midTurn[0].type === 'text' && midTurn[0].text.includes('[called read {}]') && midTurn[0].text.includes('[result of read]\nA'));
	assert.deepEqual(midTurn[1], { type: 'text', text: 'Carry on from the last tool result.' });
});

const stream = (event: object) => ({ type: 'stream_event', event, parent_tool_use_id: null }) as unknown as SDKMessage;

test('Claude Code’s messages become runtime events, with tool names unprefixed and limits recognised', () => {
	const state = { limited: false, failed: false };
	assert.deepEqual(toRuntimeEvents(stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'mcp__anton__read', input: {} } }), state), [
		{ type: 'block_start', index: 1, block: { type: 'tool_use', id: 'tu_1', name: 'read' } },
	]);
	assert.deepEqual(toRuntimeEvents(stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a' } }), state), [
		{ type: 'block_delta', index: 1, json: '{"a' },
	]);
	assert.deepEqual(toRuntimeEvents(stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }), state), [
		{ type: 'message_delta', stopReason: 'end_turn', usage: { output: 7 } },
	]);
	assert.deepEqual(toRuntimeEvents({ ...(stream({ type: 'message_stop' }) as object), parent_tool_use_id: 'tu_x' } as SDKMessage, state), [], 'a subagent’s events are left out');

	toRuntimeEvents({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } } as SDKMessage, state);
	const failed = toRuntimeEvents({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'You have used it all.' }] }, parent_tool_use_id: null } as unknown as SDKMessage, state);
	assert.deepEqual(failed, [{ type: 'error', message: 'You have used it all.', limit: true }]);
	assert.deepEqual(toRuntimeEvents({ type: 'result', subtype: 'success', is_error: true, result: 'You have used it all.' } as SDKMessage, state), [{ type: 'turn_end' }], 'the error is reported once');
	assert.deepEqual(state, { limited: false, failed: false });
	assert.deepEqual(toRuntimeEvents({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] } as unknown as SDKMessage, state), [
		{ type: 'error', message: 'boom', limit: false },
		{ type: 'turn_end' },
	]);

	assert.ok(isExtraUsageNotice({ type: 'system', subtype: 'informational', content: "You're now using extra usage · $5 left" } as unknown as SDKMessage));
	assert.ok(isExtraUsageNotice({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: true } } as SDKMessage));
	assert.ok(!isExtraUsageNotice({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } } as SDKMessage));
});

test('a sign-in counts only when it bills a plan, and the models Claude Code offers are listed by their full names', () => {
	assert.deepEqual(statusFrom({ email: 'ada@example.com', subscriptionType: 'max', tokenSource: 'claude.ai' }, '2.5.0'), {
		email: 'ada@example.com',
		plan: 'max',
		version: '2.5.0',
		signedIn: true,
		problem: null,
	});
	assert.equal(statusFrom({}, null).signedIn, false);
	assert.match(statusFrom({ apiKeySource: 'ANTHROPIC_API_KEY' }, null).problem ?? '', /API key/);
	assert.match(statusFrom({ apiProvider: 'bedrock', email: 'a@b' }, null).problem ?? '', /bedrock/);
	assert.equal(statusFrom({ email: 'a@b', subscriptionType: 'Claude API' }, null).plan, null);

	const models = toModels([
		{ value: 'default', displayName: 'Default', description: 'Recommended' },
		{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Most capable', supportsAdaptiveThinking: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
		{ value: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5' },
		{ value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest' },
		{ value: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Fastest for quick answers' },
		{ value: 'claude-fable-5-1', displayName: 'Fable', description: 'For your toughest challenges' },
	]);
	assert.deepEqual(
		models.map((model) => [model.id, model.name, model.description, model.contextLength, model.reasoning, model.defaultReasoning, model.listPrice?.input]),
		[
			['claude-code/claude-opus-5-5', 'Claude Opus 5.5', 'Most capable', 200_000, ['off', 'low', 'medium', 'high', 'max'], 'high', 5],
			['claude-code/claude-haiku-4-5', 'Claude Haiku 4.5', 'Fastest', 200_000, [], 'off', 1],
			['claude-code/claude-fable-5-1', 'Claude Fable 5.1', 'For your toughest challenges', 200_000, [], 'off', 10],
		],
	);
});

test('a model Claude Code lists under its 1M name gets 1M of context, and one with fast mode gets a fast variant', () => {
	const models = toModels([
		{
			value: 'opus[1m]',
			resolvedModel: 'claude-opus-5-5[1m]',
			displayName: 'Opus (1M context)',
			description: 'Opus 5.5 with 1M context · Long sessions',
			supportsAdaptiveThinking: true,
			supportedEffortLevels: ['low', 'high'],
			supportsFastMode: true,
		},
		{ value: 'claude-opus-5-5-20260101[1m]', displayName: 'Opus', description: 'Opus 5.5' },
		{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Everyday' },
	]);
	assert.deepEqual(
		models.map((model) => [model.id, model.name, model.contextLength, model.listPrice?.input]),
		[
			['claude-code/claude-opus-5-5[1m]', 'Claude Opus 5.5 · 1M', 1_000_000, 5],
			['claude-code/claude-opus-5-5[1m][fast]', 'Claude Opus 5.5 · 1M · Fast', 1_000_000, 30],
			['claude-code/claude-sonnet-5', 'Claude Sonnet 5', 200_000, 2],
		],
	);
	assert.match(models[1].description, /extra usage/);
	assert.deepEqual(
		models.map((model) => model.variant),
		[undefined, { of: 'claude-code/claude-opus-5-5[1m]', context: null, fast: true }, undefined],
		'a plan that serves Opus at 1M alone shows it as the model, with fast mode its variant',
	);
});

test('an alias that names 1M keeps it when its wire id does not', () => {
	const models = toModels([
		{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Everyday' },
		{ value: 'sonnet[1m]', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet (1M context)', description: 'Sonnet 5 with 1M context' },
	]);
	assert.deepEqual(
		models.map((model) => [model.id, model.contextLength, model.variant]),
		[
			['claude-code/claude-sonnet-5', 200_000, undefined],
			['claude-code/claude-sonnet-5[1m]', 1_000_000, { of: 'claude-code/claude-sonnet-5', context: '1m', fast: false }],
		],
	);
});

test('the Claude plan’s limits are read from Claude Code’s usage answer', () => {
	assert.equal(toWindows({ rate_limits_available: false, rate_limits: null }), null, 'an API key has no plan limits');
	assert.deepEqual(
		toWindows({
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: 42.5, resets_at: '2026-10-16T09:00:00Z' },
				seven_day: { utilization: 100, resets_at: '2026-10-20T00:00:00Z' },
				seven_day_opus: { utilization: null, resets_at: null },
				seven_day_sonnet: null,
				model_scoped: [{ display_name: 'Fable', utilization: 7, resets_at: null }],
				extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: 50 },
			},
		}),
		[
			{ label: '5 hours', usedPercent: 42.5, resetsAt: '2026-10-16T09:00:00Z', limited: false },
			{ label: 'Week', usedPercent: 100, resetsAt: '2026-10-20T00:00:00Z', limited: true },
			{ label: 'Week · Fable', usedPercent: 7, resetsAt: null, limited: false },
		],
	);
});

test('the Claude plan’s card shows the limits Claude Code reports, once signed in', async () => {
	const fake = fakeRuntime({}, []);
	const windows = [{ label: '5 hours', usedPercent: 12, resetsAt: null, limited: false }];
	fake.runtime.windows = async () => windows;
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, subscriptions: [], runtimes: [fake.runtime] });
	assert.deepEqual((await subscriptions.subscriptionsView())[0].windows, windows);
	fake.runtime.status = async () => ({ signedIn: false, email: null, plan: null, version: null, problem: null });
	assert.equal((await subscriptions.subscriptionsView())[0].windows, null);
	subscriptions.resetSubscriptionsForTests();
});

test('Claude Code gets no keys or tokens from Anton’s environment, and its own config folder', () => {
	const env = childEnv('/data/claude-code', { PATH: '/bin', ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'x', OPENROUTER_API_KEY: 'o', HTTPS_PROXY: 'p' });
	assert.equal(env.PATH, '/bin');
	assert.equal(env.HTTPS_PROXY, 'p');
	assert.equal(env.CLAUDE_CONFIG_DIR, '/data/claude-code');
	assert.equal(env.HOME, '/data/claude-code');
	for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENROUTER_API_KEY']) assert.equal(env[name], undefined, name);
});

test('the Claude plan shows what Claude Code says, lists its models when signed in, and cannot be disconnected from Anton', async () => {
	const { appDb } = await import('../src/db/client.ts');
	await (await appDb()).execute("DELETE FROM settings WHERE key LIKE 'subscription%'");
	const listed = toModels([{ value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: 'Opus 5 · Most capable', supportedEffortLevels: ['low', 'high'] }]);
	const fake = fakeRuntime({}, listed);
	const fakeCatalog = { name: 'openrouter', list: async () => [] as ModelInfo[] };
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: fakeCatalog, subscriptions: [], runtimes: [fake.runtime] });

	assert.ok(subscriptions.onPlan('claude-code/claude-opus-5'));
	assert.equal(subscriptions.runtimeFor('claude-code'), fake.runtime);
	const [model] = await listModels();
	assert.equal(model.id, 'claude-code/claude-opus-5');
	assert.equal(model.subscription, 'Claude');
	assert.equal(model.price.input, 0, 'plan calls count as free unless the plan says otherwise');

	const [view] = await subscriptions.subscriptionsView();
	assert.deepEqual(
		[view.kind, view.state, view.email, view.plan, view.version, view.signIn, view.models.length],
		['runtime', 'connected', 'ada@example.com', 'max', '2.5.0', fake.runtime.signInCommand, 1],
	);
	await assert.rejects(subscriptions.disconnect('claude'), /auth logout/);

	// A list an older Anton saved is not trusted after a start: Claude Code is asked again.
	const listedBefore = fake.calls.list;
	await subscriptions.subscriptionsView();
	assert.equal(fake.calls.list, listedBefore, 'listed once per start, then reused');
	listed[0] = { ...listed[0], name: 'Claude Opus 5 (renamed)' };
	subscriptions.resetSubscriptionsForTests();
	assert.equal((await subscriptions.subscriptionsView())[0].models[0].name, 'Claude Opus 5 (renamed)');
	await assert.rejects(subscriptions.beginLogin('claude'), /auth login/);

	await subscriptions.noteExtraUsage('claude');
	const noted = (await subscriptions.subscriptionsView())[0].extraUsageAt;
	assert.ok(noted);
	await subscriptions.noteExtraUsage('claude');
	assert.equal((await subscriptions.subscriptionsView())[0].extraUsageAt, noted, 'noted at most once an hour');

	const off = await subscriptions.setSubscriptionOptions('claude', { enabled: false, countAtApiPrices: false });
	assert.equal(off.options.enabled, false);
	assert.deepEqual(await listModels(), []);

	fake.runtime.status = async () => ({ signedIn: false, email: null, plan: null, version: '2.5.0', problem: null });
	const signedOut = await subscriptions.refreshSubscriptionModels('claude');
	assert.equal(signedOut.state, 'signed-out');
	assert.deepEqual(signedOut.models, []);
});
