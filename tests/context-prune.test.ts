import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Context, Message } from '@earendil-works/pi-ai';
import { compactionPoint, latestStateOnly, noteSent, pruneContext, resetPruning, warmShare } from '../src/services/context-prune.ts';
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

test('a coordinator is sent its latest project state in full and a line for each before it, the calls between sending the same start', async () => {
	const state = (threads: string, at: number): Message => ({ role: 'user', content: [{ type: 'text', text: `<signal type="project-state">\nThe project now (2026-11-13):\n${threads}\n</signal>` }], timestamp: at });
	const said = (role: 'user' | 'assistant', text: string, at: number) => ({ role, content: [{ type: 'text', text }], timestamp: at }) as unknown as Message;
	const textOf = (message: Message) => (message.content as Array<{ text: string }>)[0].text;
	const first = [said('user', 'Start on the login page', 1), state('- Login page: working', 2), said('assistant', 'Started a thread.', 3)];
	const second = [...first, said('user', 'And the docs?', 4), state('- Login page: review\n- Docs: working', 5), said('assistant', 'Started another.', 6)];
	const third = [...second, said('user', 'How is it going?', 7), state('- Login page: resolved\n- Docs: review', 8)];
	const context = (messages: Message[]) => ({ systemPrompt: 'You are the coordinator.', messages, tools: [] }) as unknown as Context;

	const one = context(first);
	assert.equal(latestStateOnly(one), one, 'one state is sent as it is');
	const none = conversation(3, 1_000);
	assert.equal(latestStateOnly(none), none, 'and so is a conversation with none');

	const two = latestStateOnly(context(second));
	assert.equal(textOf(two.messages[1]), '<signal type="project-state">\nAn earlier state of the project, left out: the latest one is the project now.\n</signal>');
	assert.equal(two.messages[4], second[4], 'the latest is whole');
	assert.equal(second[1], first[1], 'and the conversation itself keeps every one');

	// A call with nothing new since sends the same start; a newer state changes it only from the state before.
	const again = latestStateOnly(context([...second, said('user', 'Thanks', 7)]));
	assert.deepEqual(again.messages.slice(0, second.length), two.messages);
	const three = latestStateOnly(context(third));
	assert.deepEqual(three.messages.slice(0, 4), two.messages.slice(0, 4), 'what came before the state it replaced is sent as it was');
	assert.match(textOf(three.messages[4]), /An earlier state of the project/);
	assert.equal(three.messages[7], third[7]);
	for (const index of [0, 2, 3, 5, 6]) assert.equal(three.messages[index], third[index], 'what was said is never touched');

	// A message that only quotes a state is the user's own.
	const quoted = context([said('user', 'What does <signal type="project-state"> mean?', 1), state('- Login page: working', 2)]);
	assert.equal(latestStateOnly(quoted), quoted);

	const { withPruning } = await import('../src/flue/pruned-models.ts');
	const sent: Context[] = [];
	const provider = withPruning({ id: 'p', getModels: () => [], stream: (_m: unknown, sending: Context) => sent.push(sending), streamSimple: (_m: unknown, sending: Context) => sent.push(sending) } as never);
	provider.stream({ contextWindow: 1_000_000, maxTokens: 64_000 } as never, context(third), { sessionId: 'space-1' });
	assert.deepEqual(sent[0].messages, three.messages, 'a provider sends it so');
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

test('the cache counts as gone once idle past its provider’s lifetime: ten minutes on OpenAI’s, five when not given', async () => {
	const openAi = { cacheMs: 10 * MINUTE };
	pruneContext('warm', conversation(2, 1_000), POINT, 0, openAi);
	assert.equal(pruneContext('warm', conversation(28, 16_000), POINT, 7 * MINUTE, openAi).cleared, 0, 'about 112K tokens, seven minutes idle: still warm');
	pruneContext('cold', conversation(2, 1_000), POINT, 0, openAi);
	assert.ok(pruneContext('cold', conversation(28, 16_000), POINT, 11 * MINUTE, openAi).cleared > 0, 'eleven minutes idle');
	pruneContext('other', conversation(2, 1_000), POINT, 0, {});
	assert.ok(pruneContext('other', conversation(28, 16_000), POINT, 7 * MINUTE, {}).cleared > 0, 'five minutes when not given');

	const { pruneModel } = await import('../src/flue/pruned-models.ts');
	const price = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 };
	assert.deepEqual(pruneModel({ provider: 'openai', id: 'gpt-6.1-terra[872k]', api: 'openai-responses', cost: price } as never), { price, dropThinking: false, cacheMs: 10 * MINUTE });
	assert.deepEqual(pruneModel({ provider: 'openrouter', id: 'openai/gpt-5.5', api: 'openai-completions' } as never).cacheMs, 10 * MINUTE);
	assert.deepEqual(pruneModel({ provider: 'openrouter', id: 'anthropic/claude-sonnet-5.5', api: 'openai-completions' } as never).cacheMs, 5 * MINUTE);
	assert.deepEqual(pruneModel({ provider: 'opencode-go', id: 'glm-5.1', api: 'openai-completions' } as never).cacheMs, 5 * MINUTE);
});

test('the size is what the provider counted of the previous call, with what was added since estimated', () => {
	// About 88K tokens by characters; the provider counted 130K, as code and JSON run to fewer characters a token.
	const dense = pruneContext('dense', conversation(22, 16_000), POINT, 0);
	assert.equal(dense.cleared, 0);
	noteSent('dense', dense.call, { input: 20_000, cacheRead: 110_000, cacheWrite: 0 });
	// Two results later and gone cold: about 96K by characters, under half the mark, but 130K and two results counted.
	assert.ok(pruneContext('dense', conversation(24, 16_000), POINT, 7 * MINUTE).cleared > 0);
	pruneContext('estimated', conversation(22, 16_000), POINT, 0);
	assert.equal(pruneContext('estimated', conversation(24, 16_000), POINT, 7 * MINUTE).cleared, 0, 'without a count, the estimate decides');

	// Two results later, about 104K by characters, past half the mark; the provider counted far less.
	const sparse = pruneContext('sparse', conversation(24, 16_000), POINT, 0);
	noteSent('sparse', sparse.call, { input: 70_000 });
	assert.equal(pruneContext('sparse', conversation(26, 16_000), POINT, 7 * MINUTE).cleared, 0);
	pruneContext('sparse-estimated', conversation(24, 16_000), POINT, 0);
	assert.ok(pruneContext('sparse-estimated', conversation(26, 16_000), POINT, 7 * MINUTE).cleared > 0);
});

test('a count is not used for a call it was not of, nor once the conversation starts otherwise', () => {
	const count = { input: 30_000, cacheRead: 100_000 };
	// A count of an older call, or of a failed one.
	const older = pruneContext('older', conversation(22, 16_000), POINT, 0);
	pruneContext('older', conversation(23, 16_000), POINT, MINUTE);
	noteSent('older', older.call, count);
	assert.equal(pruneContext('older', conversation(24, 16_000), POINT, 7 * MINUTE).cleared, 0);
	const failed = pruneContext('failed', conversation(22, 16_000), POINT, 0);
	noteSent('failed', failed.call, { input: 0, cacheRead: 0, cacheWrite: 0 });
	noteSent('failed', failed.call, undefined);
	assert.equal(pruneContext('failed', conversation(24, 16_000), POINT, 7 * MINUTE).cleared, 0);
	// A compaction rewrote the conversation, or the system prompt changed.
	const compacted = pruneContext('compacted', conversation(22, 16_000), POINT, 0);
	noteSent('compacted', compacted.call, count);
	const rewritten = conversation(24, 16_000);
	rewritten.messages = [{ role: 'user', content: 'Summary of the work so far.', timestamp: 1 }, ...rewritten.messages.slice(3)];
	const after = pruneContext('compacted', rewritten, POINT, 7 * MINUTE);
	assert.equal(after.cleared, 0);
	assert.ok(after.tokens < 100_000, `${after.tokens} tokens, the estimate`);
	const prompted = pruneContext('prompted', conversation(22, 16_000), POINT, 0);
	noteSent('prompted', prompted.call, count);
	assert.equal(pruneContext('prompted', { ...conversation(24, 16_000), systemPrompt: 'You are Anton, with a longer prompt.' }, POINT, 7 * MINUTE).cleared, 0);
});

test('a count that matches the estimate sizes the next call as the estimate does, reasoning left out counted once', () => {
	const first = pruneContext('counted', reasoned(30, 16_000), POINT, 0, { dropThinking: true });
	assert.ok(first.cleared > 0);
	noteSent('counted', first.call, { input: first.tokens });
	pruneContext('estimated', reasoned(30, 16_000), POINT, 0, { dropThinking: true });
	const counted = pruneContext('counted', reasoned(31, 16_000), POINT, MINUTE, { dropThinking: true });
	const estimated = pruneContext('estimated', reasoned(31, 16_000), POINT, MINUTE, { dropThinking: true });
	assert.equal(counted.cleared, first.cleared, 'no new batch');
	assert.equal(counted.tokens, estimated.tokens);
	assert.ok(counted.tokens > first.tokens);
});

test('a provider hands each call’s count of what it sent to the clearing of that conversation’s next call', async () => {
	const { withPruning } = await import('../src/flue/pruned-models.ts');
	const sent: Context[] = [];
	const counted = { input: 1_000, cacheRead: 169_000, cacheWrite: 0 };
	const provider = withPruning({
		id: 'p',
		getModels: () => [],
		stream: () => undefined,
		streamSimple: (_m: unknown, context: Context) => {
			sent.push(context);
			return { result: () => Promise.resolve({ usage: counted }) };
		},
	} as never);
	const model = { provider: 'openrouter', id: 'anthropic/claude-sonnet-5.5', api: 'openai-completions', contextWindow: 1_000_000, maxTokens: 64_000 } as never;
	provider.streamSimple(model, conversation(22, 16_000), { sessionId: 'aff-counted' });
	await new Promise((resolve) => setImmediate(resolve));
	// A warm cache and no price: only past 85% of the mark, which 96K by characters is far from, and 170K and two results counted is past.
	provider.streamSimple(model, conversation(24, 16_000), { sessionId: 'aff-counted' });
	assert.match(resultText(sent[1], 'c0'), /^\[Cleared/);
	assert.equal(resultText(sent[0], 'c0'), '0'.repeat(16_000));
});
