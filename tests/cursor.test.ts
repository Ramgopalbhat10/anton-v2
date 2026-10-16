import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { Message } from '@earendil-works/pi-ai';
import type { ModelInfo } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-cursor-'));
process.env.ANTON_DATA_DIR = dir;

const { cursorPlan, levelsOf, selectionFor, toSubscriptionModel, toSubscriptionModels } = await import('../src/providers/cursor/plan.ts');
const { cursorProvider, closeClaudeCodeConversations, estimatedUsage } = await import('../src/flue/claude-code-models.ts');
const { createModels } = await import('@earendil-works/pi-ai');

after(() => {
	closeClaudeCodeConversations();
	rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => closeClaudeCodeConversations());

const gpt = {
	id: 'gpt-5.5',
	displayName: 'GPT-5.5',
	parameters: [
		{ id: 'reasoning', values: [{ value: 'none' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'extra-high' }] },
		{ id: 'context', values: [{ value: '1m' }, { value: '272k' }] },
		{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
	],
};
const sonnet = {
	id: 'claude-sonnet-5',
	displayName: 'Sonnet 5',
	parameters: [{ id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] }],
};
const composer = { id: 'composer-2', displayName: 'Composer 2' };

test('Cursor’s models are listed with the efforts their parameters name, at their smallest context', () => {
	assert.deepEqual(levelsOf(gpt as never), ['off', 'low', 'medium', 'high', 'xhigh']);
	assert.deepEqual(levelsOf(sonnet as never), ['off', 'high'], 'a thinking switch alone runs at the model’s own effort');
	assert.deepEqual(levelsOf(composer as never), []);

	const listed = toSubscriptionModel(gpt as never)!;
	assert.deepEqual([listed.id, listed.name, listed.vendor, listed.contextLength, listed.defaultReasoning], ['cursor/gpt-5.5', 'GPT-5.5', 'OpenAI', 272_000, 'high']);
	assert.equal(listed.listPrice, null, 'Cursor publishes no per-token prices for its agent');
	assert.equal(toSubscriptionModel({ id: 'default', displayName: 'Auto' } as never), null);
	assert.equal(toSubscriptionModel(composer as never)!.vendor, 'Cursor');

	assert.deepEqual(selectionFor('gpt-5.5', gpt as never, 'xhigh'), {
		id: 'gpt-5.5',
		params: [
			{ id: 'reasoning', value: 'extra-high' },
			{ id: 'context', value: '272k' },
		],
	});
	assert.deepEqual(selectionFor('claude-sonnet-5', sonnet as never, 'off'), { id: 'claude-sonnet-5', params: [{ id: 'thinking', value: 'false' }] });
	assert.deepEqual(selectionFor('composer-2', undefined, 'high'), { id: 'composer-2' });
});

test('Cursor’s larger context and fast mode are listed as variants, and each picks its parameter', () => {
	assert.deepEqual(
		toSubscriptionModels(gpt as never).map((model) => [model.id, model.name, model.contextLength]),
		[
			['cursor/gpt-5.5', 'GPT-5.5', 272_000],
			['cursor/gpt-5.5[1m]', 'GPT-5.5 · 1M', 1_000_000],
			['cursor/gpt-5.5[fast]', 'GPT-5.5 · Fast', 272_000],
		],
	);
	assert.deepEqual(toSubscriptionModels(sonnet as never).map((model) => model.id), ['cursor/claude-sonnet-5']);
	assert.deepEqual(selectionFor('gpt-5.5[1m]', gpt as never, 'high'), {
		id: 'gpt-5.5',
		params: [
			{ id: 'reasoning', value: 'high' },
			{ id: 'context', value: '1m' },
		],
	});
	assert.deepEqual(selectionFor('gpt-5.5[fast]', gpt as never, null), {
		id: 'gpt-5.5',
		params: [
			{ id: 'context', value: '272k' },
			{ id: 'fast', value: 'true' },
		],
	});
	assert.deepEqual(selectionFor('claude-sonnet-5[fast]', sonnet as never, null), { id: 'claude-sonnet-5' }, 'a model without fast mode runs at its own speed');
});

type Script = (agent: { onDelta: (update: object) => void; tools: Record<string, { execute: (args: unknown, context: { toolCallId: string }) => Promise<unknown> }> }) => Promise<{ status: string; error?: { message: string } }>;

/** Cursor’s SDK as the plan sees it: each message the agent is sent plays the next script. */
function fakeSdk(scripts: Script[]) {
	const created: Array<Record<string, unknown>> = [];
	const sent: Array<{ text: string }> = [];
	const sdk = {
		Cursor: {
			me: async ({ apiKey }: { apiKey: string }) => {
				if (apiKey !== 'key_good') throw new Error('Invalid API key');
				return { apiKeyName: 'Anton', userEmail: 'ada@example.com' };
			},
			models: { list: async () => [gpt, sonnet, composer, { id: 'default', displayName: 'Auto' }] },
		},
		JsonlLocalAgentStore: class {
			root: string;
			constructor(root: string) {
				this.root = root;
			}
		},
		Agent: {
			create: async (options: Record<string, unknown>) => {
				created.push(options);
				const tools = (options.local as { customTools: never }).customTools;
				return {
					send: async (message: { text: string }, { onDelta }: { onDelta: (event: { update: object }) => void }) => {
						sent.push(message);
						const script = scripts.shift();
						assert.ok(script, 'a script for each message');
						const result = script({ onDelta: (update) => onDelta({ update }), tools });
						return { wait: () => result, cancel: async () => {} };
					},
					close: () => {},
				};
			},
		},
	};
	return { sdk: async () => sdk as never, created, sent };
}

const info: ModelInfo = {
	id: 'cursor/gpt-5.5',
	name: 'GPT-5.5',
	vendor: 'OpenAI',
	description: '',
	createdAt: 0,
	contextLength: 272_000,
	maxOutput: null,
	price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	vision: true,
	reasoning: ['off', 'low', 'medium', 'high', 'xhigh'],
	defaultReasoning: 'high',
	subscription: 'Cursor',
};

function bridge(fake: ReturnType<typeof fakeSdk>, hooks: Parameters<typeof cursorProvider>[2] = {}) {
	const plan = cursorPlan({ dir, sdk: fake.sdk });
	const models = createModels();
	models.setProvider(cursorProvider(() => [info], async () => ({ open: (options) => plan.open!('key_good', options) }), hooks));
	const model = models.getModel('cursor', 'gpt-5.5');
	assert.ok(model, 'the plan model resolves under cursor/');
	return { models, model };
}

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 });
const readTool = { name: 'read', description: 'Reads a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } as never;
const turnEnded = (inputTokens: number, outputTokens: number) => ({ type: 'turn-ended', usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } });

test('the plan checks a key with Cursor and lists the account’s models', async () => {
	const fake = fakeSdk([]);
	const plan = cursorPlan({ dir, sdk: fake.sdk });
	assert.deepEqual(await plan.check('key_good'), { email: 'ada@example.com' });
	await assert.rejects(plan.check('key_bad'), /Invalid API key/);
	assert.deepEqual(
		(await plan.listModels('key_good')).map((model) => model.id),
		['cursor/gpt-5.5', 'cursor/gpt-5.5[1m]', 'cursor/gpt-5.5[fast]', 'cursor/claude-sonnet-5', 'cursor/composer-2'],
	);
});

test('a Cursor run is cut into steps at its tool calls, and each call waits for Flue’s result', async () => {
	let read: unknown;
	const fake = fakeSdk([
		async ({ onDelta, tools }) => {
			onDelta({ type: 'thinking-delta', text: 'Look first.' });
			onDelta({ type: 'text-delta', text: 'Reading.' });
			read = await tools.read.execute({ path: 'a.ts' }, { toolCallId: 'tc_1' });
			onDelta({ type: 'text-delta', text: 'It says A.' });
			onDelta(turnEnded(1200, 40));
			return { status: 'finished' };
		},
	]);
	const { models, model } = bridge(fake);
	const context = { systemPrompt: 'Be Anton.', messages: [user('Read a.ts.')], tools: [readTool] };

	const step1 = await models.completeSimple(model, context, { sessionId: 'c1', reasoning: 'xhigh' });
	assert.equal(step1.stopReason, 'toolUse', step1.errorMessage);
	assert.deepEqual(
		step1.content.map((block) => (block.type === 'toolCall' ? [block.id, block.name, block.arguments] : [block.type])),
		[['thinking'], ['text'], ['tc_1', 'read', { path: 'a.ts' }]],
	);

	const [options] = fake.created;
	assert.equal(options.apiKey, 'key_good');
	assert.deepEqual(options.tools, ['mcp'], 'Cursor’s own shell, edits and reads stay off');
	assert.deepEqual(options.model, {
		id: 'gpt-5.5',
		params: [
			{ id: 'reasoning', value: 'extra-high' },
			{ id: 'context', value: '272k' },
		],
	});
	const local = options.local as { cwd: string; settingSources: unknown[]; customTools: object };
	assert.equal(local.cwd, path.join(dir, 'work'));
	assert.deepEqual(local.settingSources, [], 'no project or user settings are read on the server');
	assert.deepEqual(Object.keys(local.customTools), ['read']);
	assert.match(fake.sent[0].text, /^You are working for Anton[\s\S]*<instructions>\nBe Anton\.\n<\/instructions>\n\nRead a\.ts\.$/);

	const messages = [...context.messages, step1, { role: 'toolResult', toolCallId: 'tc_1', toolName: 'read', content: [{ type: 'text', text: 'A' }], isError: false, timestamp: 0 } as Message];
	const step2 = await models.completeSimple(model, { ...context, messages }, { sessionId: 'c1', reasoning: 'xhigh' });
	assert.equal(step2.stopReason, 'stop', step2.errorMessage);
	assert.deepEqual(step2.content, [{ type: 'text', text: 'It says A.' }]);
	// Cursor's count is the whole run's; each step is counted by the context it was sent and what it wrote.
	assert.deepEqual([step2.usage.input, step2.usage.output], [estimatedUsage({ ...context, messages }, step2.content).input, 3]);
	assert.ok(step1.usage.input > 0 && step1.usage.input < step2.usage.input, 'each step holds the context it was sent');
	assert.deepEqual(read, { content: [{ type: 'text', text: 'A' }], isError: false });
	assert.equal(fake.created.length, 1, 'one Cursor agent for the conversation');
});

test('a long run’s count, every model call in it summed, is not read as the last step’s context', async () => {
	const fake = fakeSdk([
		async ({ onDelta, tools }) => {
			for (let i = 0; i < 6; i++) await tools.read.execute({ path: `${i}.ts` }, { toolCallId: `tc_${i}` });
			onDelta({ type: 'text-delta', text: 'Done.' });
			// Six calls that each re-read a growing context: far past a 272K window together.
			onDelta(turnEnded(600_000, 3_000));
			return { status: 'finished' };
		},
	]);
	const { models, model } = bridge(fake);
	const context = { systemPrompt: 'Be Anton.', messages: [user('Read them all.')], tools: [readTool] };
	let messages: Message[] = [...context.messages];
	let step = await models.completeSimple(model, context, { sessionId: 'c3' });
	for (let i = 0; step.stopReason === 'toolUse'; i++) {
		const call = step.content.find((block) => block.type === 'toolCall')!;
		messages = [...messages, step, { role: 'toolResult', toolCallId: call.id, toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(4000) }], isError: false, timestamp: 0 } as Message];
		step = await models.completeSimple(model, { ...context, messages }, { sessionId: 'c3' });
		assert.ok(i < 10);
	}
	assert.equal(step.stopReason, 'stop', step.errorMessage);
	assert.equal(step.usage.input, estimatedUsage({ ...context, messages }, step.content).input);
	assert.ok(step.usage.input + step.usage.cacheRead < info.contextLength, 'the runtime sees no overflow, so it does not compact after the reply');
});

test('a call outside any conversation, such as compaction’s summary, closes its Cursor agent when it answers', async () => {
	let closed = 0;
	const fake = fakeSdk([
		async ({ onDelta }) => {
			onDelta({ type: 'text-delta', text: 'The summary.' });
			return { status: 'finished' };
		},
		async ({ onDelta }) => {
			onDelta({ type: 'text-delta', text: 'Hello.' });
			return { status: 'finished' };
		},
	]);
	const create = (await fake.sdk()) as unknown as { Agent: { create: (options: object) => Promise<{ close: () => void }> } };
	const made = create.Agent.create;
	create.Agent.create = async (options) => {
		const agent = await made(options);
		return { ...agent, close: () => void (closed += 1) };
	};
	const { models, model } = bridge(fake);
	const summary = await models.completeSimple(model, { systemPrompt: 'Summarise.', messages: [user('The conversation.')] });
	assert.equal(summary.stopReason, 'stop', summary.errorMessage);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(closed, 1, 'nothing will continue it, so it does not hold one of the plan’s open places');
	const reply = await models.completeSimple(model, { systemPrompt: '', messages: [user('Hi.')] }, { sessionId: 'c4' });
	assert.equal(reply.stopReason, 'stop', reply.errorMessage);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(closed, 1, 'a conversation’s agent stays open for its next step');
});

test('a run Cursor stops at the plan’s limit fails the step and is reported as the limit', async () => {
	let limits = 0;
	const fake = fakeSdk([async () => ({ status: 'error', error: { message: 'You have hit your usage limit for this billing cycle.' } })]);
	const { models, model } = bridge(fake, { onLimit: () => (limits += 1) });
	const reply = await models.completeSimple(model, { systemPrompt: '', messages: [user('Hi.')], tools: [] }, { sessionId: 'c2' });
	assert.equal(reply.stopReason, 'error');
	assert.match(reply.errorMessage ?? '', /usage limit/);
	assert.equal(limits, 1);
});
