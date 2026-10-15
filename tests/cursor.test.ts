import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { Message } from '@earendil-works/pi-ai';
import type { ModelInfo } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-cursor-'));
process.env.ANTON_DATA_DIR = dir;

const { cursorPlan, levelsOf, selectionFor, toSubscriptionModel } = await import('../src/providers/cursor/plan.ts');
const { cursorProvider, closeClaudeCodeConversations } = await import('../src/flue/claude-code-models.ts');
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
		['cursor/gpt-5.5', 'cursor/claude-sonnet-5', 'cursor/composer-2'],
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
	assert.deepEqual([step2.usage.input, step2.usage.output], [1200, 40]);
	assert.deepEqual(read, { content: [{ type: 'text', text: 'A' }], isError: false });
	assert.equal(fake.created.length, 1, 'one Cursor agent for the conversation');
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
