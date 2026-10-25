import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Context, Message } from '@earendil-works/pi-ai';
import { compactionPoint, pruneContext, resetPruning } from '../src/services/context-prune.ts';
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
