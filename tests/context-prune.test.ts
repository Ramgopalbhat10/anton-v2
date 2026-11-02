import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Context, Message } from '@earendil-works/pi-ai';
import { compactionPoint, pruneContext, resetPruning, warmShare } from '../src/services/context-prune.ts';
import { readFullResult } from '../src/services/tool-results.ts';

const MINUTE = 60_000;
const POINT = 200_000;

/** A conversation of `results` tool calls, each answered with `chars` characters. */
function conversation(results: number, chars: number, tools = [{ name: 'read_full_result' }]): Context {
	const messages: Message[] = [{ role: 'user', content: 'Look into it', timestamp: 0 }];
	for (let index = 0; index < results; index++) {
		messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: `c${index}`, name: 'web_fetch', arguments: { url: `https://example.com/${index}` } }], timestamp: 0 } as unknown as Message);
		messages.push({ role: 'toolResult', toolCallId: `c${index}`, toolName: 'web_fetch', content: [{ type: 'text', text: String(index % 10).repeat(chars) }], isError: false, timestamp: 0 });
	}
	return { systemPrompt: 'You are Anton.', messages, tools } as unknown as Context;
}
const resultText = (context: Context, id: string) => {
	const message = context.messages.find((entry) => entry.role === 'toolResult' && entry.toolCallId === id) as { content: Array<{ text: string }> };
	return message.content[0].text;
};

beforeEach(() => resetPruning());

test('below half of the compaction point nothing is cleared', () => {
	const context = conversation(20, 16_000); // about 80K tokens
	const pruned = pruneContext('a', context, POINT, 0);
	assert.equal(pruned.context, context);
	assert.equal(pruned.cleared, 0);
});

test('past it, the oldest results are cleared in one batch down to 30%, the newest 20K tokens kept', () => {
	const context = conversation(30, 16_000); // about 120K tokens
	const pruned = pruneContext('a', context, POINT, 0);
	assert.ok(pruned.tokens <= POINT * 0.3, `${pruned.tokens} tokens left`);
	assert.match(resultText(pruned.context, 'c0'), /^\[Cleared to keep the conversation small: this web_fetch result ran to 16,000 characters\. Call read_full_result with id "c0" and offset 0 if you need it again\.\]$/);
	for (const id of ['c29', 'c28', 'c27', 'c26', 'c25']) assert.equal(resultText(pruned.context, id), resultText(context, id), `${id} is among the newest`);
	assert.equal(resultText(context, 'c0'), '0'.repeat(16_000), 'the conversation itself is left whole');
	assert.equal(readFullResult('task', 'c0', 0), '0'.repeat(16_000), 'and the agent can read a cleared one again');
});

test('what was cleared stays cleared, so the calls between batches send the same start', () => {
	const first = pruneContext('a', conversation(30, 16_000), POINT, 0);
	const later = pruneContext('a', conversation(34, 16_000), POINT, MINUTE);
	assert.equal(later.cleared, first.cleared, 'no new batch while under the urgent mark and the cache is warm');
	assert.deepEqual(later.context.messages.slice(0, first.context.messages.length), first.context.messages);
});

test('while the cache is warm it waits until compaction is near (85%); once it has gone cold, it clears at 50%', () => {
	pruneContext('warm', conversation(2, 1_000), POINT, 0);
	assert.equal(pruneContext('warm', conversation(28, 16_000), POINT, MINUTE).cleared, 0, 'about 112K tokens, under 85%');
	assert.ok(pruneContext('warm', conversation(28, 16_000), POINT, 7 * MINUTE).cleared > 0, 'the same, after the cache expired');
	pruneContext('urgent', conversation(2, 1_000), POINT, 0);
	assert.ok(pruneContext('urgent', conversation(45, 16_000), POINT, MINUTE).cleared > 0, 'about 180K tokens, past 85%');
});

test('small results stay, and an agent without read_full_result is told to call the tool again', () => {
	const small = pruneContext('s', conversation(300, 1_500), POINT, 0);
	assert.equal(small.cleared, 0);
	const pruned = pruneContext('b', conversation(30, 16_000, []), POINT, 0);
	assert.match(resultText(pruned.context, 'c0'), /Call the tool again if you need it\.\]$/);
	assert.equal(pruneContext('c', conversation(30, 16_000), 0, 0).cleared, 0, 'a model with no known window');
});

test('the compaction point follows Compact at, else the window less the runtime’s reserve', () => {
	assert.equal(compactionPoint({ contextWindow: 1_000_000, maxTokens: 64_000 }, 200_000), 200_000);
	assert.equal(compactionPoint({ contextWindow: 128_000, maxTokens: 16_000 }, 200_000), 112_000);
	assert.equal(compactionPoint({ contextWindow: 0, maxTokens: 0 }, 200_000), 0);
});

test('a provider sends the pruned context for a call that names its conversation, and any other as it is', async () => {
	const { withPruning } = await import('../src/flue/pruned-models.ts');
	const sent: Context[] = [];
	const provider = withPruning({ id: 'p', getModels: () => [], stream: (_m: unknown, context: Context) => sent.push(context), streamSimple: (_m: unknown, context: Context) => sent.push(context) } as never);
	const model = { contextWindow: 1_000_000, maxTokens: 64_000 } as never;
	const context = conversation(30, 16_000);
	provider.streamSimple(model, context, { sessionId: 'aff-1' });
	provider.stream(model, context, {});
	assert.notEqual(sent[0], context);
	assert.match(resultText(sent[0], 'c0'), /^\[Cleared/);
	assert.equal(sent[1], context);
});

const SONNET = { input: 3, cacheRead: 0.3, cacheWrite: 3.75 };
const DEEPSEEK = { input: 0.3, cacheRead: 0.006, cacheWrite: 0 };

test('how long a warm cache waits follows the price: half the mark where the cache takes 90% off, 85% where it takes 98% off', () => {
	assert.equal(warmShare(SONNET), 0.5);
	assert.equal(warmShare({ input: 1.25, cacheRead: 0.125, cacheWrite: 0 }), 0.5);
	assert.equal(warmShare(DEEPSEEK), 0.85);
	assert.equal(warmShare(), 0.85, 'a plan has no price');
	assert.equal(warmShare({ input: 0, cacheRead: 0, cacheWrite: 0 }), 0.85);
});

test('a conversation clears early on a warm cache only once it has made the calls the batch pays back in', () => {
	// About 112K tokens: past half the mark, under 85%. Sonnet pays back a batch from 112K down to 60K in about 14 calls.
	pruneContext('young', conversation(2, 1_000), POINT, 0, { price: SONNET });
	assert.equal(pruneContext('young', conversation(28, 16_000), POINT, MINUTE, { price: SONNET }).cleared, 0, 'two calls in, a chat that may end soon');
	for (let call = 0; call < 14; call++) pruneContext('long', conversation(2, 1_000), POINT, call * 1_000, { price: SONNET });
	assert.ok(pruneContext('long', conversation(28, 16_000), POINT, MINUTE, { price: SONNET }).cleared > 0, 'fifteen calls in');
	for (let call = 0; call < 200; call++) pruneContext('cheap', conversation(2, 1_000), POINT, call * 1_000, { price: DEEPSEEK });
	assert.equal(pruneContext('cheap', conversation(28, 16_000), POINT, MINUTE, { price: DEEPSEEK }).cleared, 0, 'DeepSeek waits for 85% however long the task');
});

/** A conversation whose assistant messages each reason before their tool call. */
function reasoned(results: number, chars: number): Context {
	const context = conversation(results, chars);
	context.messages = context.messages.map((message) =>
		message.role === 'assistant' ? ({ ...message, content: [{ type: 'thinking', thinking: 'x'.repeat(8_000), thinkingSignature: 'reasoning_content' }, ...(message.content as unknown[])] } as unknown as Message) : message,
	);
	return context;
}
const thinks = (message: Message) => (message.content as Array<{ type: string }>).some((part) => part.type === 'thinking');

test('reasoning before the newest cleared result is left out where the API allows it, and kept after it and elsewhere', () => {
	const pruned = pruneContext('r', reasoned(30, 16_000), POINT, 0, { dropThinking: true });
	const messages = pruned.context.messages;
	const edge = messages.findLastIndex((message) => message.role === 'toolResult' && /^\[Cleared/.test((message.content as Array<{ text: string }>)[0].text));
	assert.ok(edge > 0);
	for (const [index, message] of messages.entries()) {
		if (message.role !== 'assistant') continue;
		assert.equal(thinks(message), index > edge, `assistant message ${index}`);
		assert.ok((message.content as Array<{ type: string }>).some((part) => part.type === 'toolCall'), 'its tool call stays');
	}
	// The next call, before another batch, sends the same start.
	const later = pruneContext('r', reasoned(32, 16_000), POINT, MINUTE, { dropThinking: true });
	assert.deepEqual(later.context.messages.slice(0, edge + 1), messages.slice(0, edge + 1));
	const kept = pruneContext('k', reasoned(30, 16_000), POINT, 0);
	assert.ok(kept.context.messages.filter((message) => message.role === 'assistant').every(thinks), 'without dropThinking, all reasoning stays');
	assert.ok(pruned.tokens < kept.tokens);
});
