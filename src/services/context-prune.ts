import type { Context, Message, Model, Api } from '@earendil-works/pi-ai';
import { DEFAULT_CACHE_MS } from '../core/prompt-cache.ts';
import { compactionReserve } from './context-usage.ts';
import { compactionCeiling } from './general.ts';
import { keepCleared, MORE_TOOL } from './tool-results.ts';

/*
 * Old tool results, cleared from what a model call sends once a conversation
 * grows, so compaction (a summary that loses detail) comes much later. Every
 * call sends the whole conversation, and a page read an hour ago still costs
 * its tokens on each one. Past half of where the agent compacts, the oldest
 * results beyond the newest 20K tokens of them give way to a one-line stub,
 * down to 30%, and the agent can read one again with `read_full_result`.
 *
 * Clearing changes the conversation from the first result cleared, so the
 * provider's prompt cache misses once, on that call. So it clears in batches
 * (never one result at a time), and while the cache is warm it waits until
 * compaction is near (85%), where it saves a summary call and its detail
 * lost; once idle past the provider's cache lifetime (`cacheLifetime`, five
 * minutes on most, ten on OpenAI's), when the cache has expired anyway, it
 * clears as soon as it passes the mark. Replayed on real tasks, clearing
 * sooner with a warm cache cost more in misses than it saved. What was cleared
 * stays cleared on every later call, so the cache holds between batches. The
 * runtime keeps the conversation itself whole: this only changes what is sent.
 *
 * How long to wait with a warm cache depends on the model's prices: a miss
 * costs the uncached price on what is sent again, and each later call saves the
 * cached price on what was cleared. Where the cache takes 90% off (Claude, GPT)
 * a batch at half the mark pays back within a few calls, and a replay of long
 * coding tasks at those prices spent 11% to 13% less on input clearing there;
 * where it takes 98% off (DeepSeek), the same replay spent 9% more, so such a
 * model still waits for 85%. A conversation clears early only once it has made
 * as many calls as the batch needs to pay back, so a short chat never does.
 *
 * A conversation's size is what the provider counted of its previous call,
 * cached or not, with what was added since estimated, a token for every four
 * characters. The estimate alone is used for a first call, after a restart,
 * and once the conversation no longer starts as that call's did (after a
 * compaction, or with a system prompt or tool list of another size). Code and
 * JSON often run to fewer than four characters a token, so the estimate alone
 * can fall short of what is sent.
 *
 * Reasoning the model wrote before the newest cleared result is left out too,
 * for APIs that take a conversation without it (Chat Completions, Anthropic
 * Messages; the Responses API wants each tool call's reasoning item). It is
 * often the larger part of an agent's old messages, and leaving it out where a
 * batch already changed the conversation adds no miss of its own.
 */

/** Clearing starts past this share of where the agent compacts, */
const START = 0.5;
/** and while the provider's cache is warm, only past this share, in place of compacting soon, */
const URGENT = 0.85;
/** and stops at this share. */
const TARGET = 0.3;
/** The newest tool results the agent is likely still working from, which are never cleared. */
const PROTECT_TOKENS = 20_000;
/** The calls a batch clearing early is expected to pay back its miss within, where the price says when. */
const PAYBACK_CALLS = 25;
/** A result this small costs little more than its stub. */
const MIN_CHARS = 2_000;
/** Conversations whose cleared results are remembered, the least recently called dropped first. */
const KEEP_CONVERSATIONS = 200;
/** What a picture counts for, about what providers charge for a screenshot. */
const IMAGE_TOKENS = 1_600;

/** What a conversation's latest call sent: its number, how many messages, the last of them, its system prompt and tools' size, and what the provider counted. */
type Sent = { call: number; messages: number; mark: string; fixed: number; tokens: number | null };
type State = { cleared: Set<string>; lastAt: number | null; calls: number; sent: Sent | null };
const conversations = new Map<string, State>();

/** The runtime's rule of thumb for a size it does not measure. */
const tokensOf = (chars: number) => Math.ceil(chars / 4);

type Part = { type: string; text?: string; thinking?: string; arguments?: unknown };

/** A model's prices per million tokens, as pi-ai lists them. */
export type Price = { input: number; cacheRead: number; cacheWrite: number };
/**
 * What a call's model tells the clearing: its prices, whether its API takes old reasoning left out, and how long its
 * provider's cache lasts after its last use (`cacheLifetime` in src/core/prompt-cache.ts; five minutes when not given).
 */
export type PruneModel = { price?: Price; dropThinking?: boolean; cacheMs?: number };

const missPrice = (price: Price) => Math.max(price.input, price.cacheWrite || 0) - price.cacheRead;
const priced = (price: Price | undefined): price is Price => Boolean(price && price.cacheRead > 0 && price.input > price.cacheRead);

/**
 * The share of the compaction point past which a batch clears while the cache is warm: where clearing down to 30%
 * pays back its miss within `PAYBACK_CALLS` calls, between half and 85%. Without prices (a plan), 85%.
 */
export function warmShare(price?: Price): number {
	if (!priced(price)) return URGENT;
	return Math.min(URGENT, Math.max(START, TARGET * (1 + missPrice(price) / (price.cacheRead * PAYBACK_CALLS))));
}

/** Whether a conversation has made as many calls as a batch from `tokens` down to 30% needs to pay back its miss. */
function paysBack(calls: number, tokens: number, point: number, price: Price): boolean {
	const after = point * TARGET;
	const saved = tokens - after;
	return saved > 0 && calls * saved * price.cacheRead >= after * missPrice(price);
}

function messageTokens(message: Message): number {
	if (typeof message.content === 'string') return tokensOf(message.content.length);
	let tokens = 0;
	for (const part of message.content as Part[]) {
		if (part.type === 'image') tokens += IMAGE_TOKENS;
		else if (part.type === 'text') tokens += tokensOf(part.text?.length ?? 0);
		else if (part.type === 'thinking') tokens += tokensOf(part.thinking?.length ?? 0);
		else if (part.type === 'toolCall') tokens += tokensOf(JSON.stringify(part.arguments ?? {}).length);
	}
	return tokens;
}

const textOf = (message: Message) =>
	typeof message.content === 'string'
		? message.content
		: (message.content as Part[])
				.filter((part) => part.type === 'text')
				.map((part) => part.text ?? '')
				.join('\n\n');

function stub(toolName: string, toolCallId: string, chars: number, canRead: boolean): string {
	const size = `this ${toolName} result ran to ${chars.toLocaleString('en-US')} characters.`;
	return canRead
		? `[Cleared to keep the conversation small: ${size} Call ${MORE_TOOL} with id "${toolCallId}" and offset 0 if you need it again.]`
		: `[Cleared to keep the conversation small: ${size} Call the tool again if you need it.]`;
}

/** Where the agent compacts on this model: at Settings › General's Compact at, or where the runtime would. */
export function compactionPoint(model: Pick<Model<Api>, 'contextWindow' | 'maxTokens'>, ceiling = compactionCeiling()): number {
	const window = model.contextWindow;
	return window > 0 ? window - compactionReserve(window, model.maxTokens || null, ceiling) : 0;
}

/** A call is the same message when it has the same role, time and tool call, as it does from one call to the next. */
const markOf = (message: Message | undefined) => (message ? `${message.role}:${message.timestamp}:${message.role === 'toolResult' ? message.toolCallId : ''}` : '');

/** The context to send, how many results it has cleared, its size in tokens, and the call's number in its conversation, for `noteSent`. */
export type Pruned = { context: Context; cleared: number; tokens: number; call: number };

/**
 * The context a model call sends for conversation `key` (the runtime's session id for it): its results cleared so
 * far given stubs, and a new batch cleared when it has grown past the mark.
 */
export function pruneContext(key: string, context: Context, point: number, now = Date.now(), model: PruneModel = {}): Pruned {
	const state = conversations.get(key) ?? { cleared: new Set<string>(), lastAt: null, calls: 0, sent: null };
	state.calls += 1;
	conversations.delete(key);
	conversations.set(key, state);
	if (conversations.size > KEEP_CONVERSATIONS) conversations.delete(conversations.keys().next().value!);
	const cold = state.lastAt === null || now - state.lastAt >= (model.cacheMs ?? DEFAULT_CACHE_MS);
	state.lastAt = now;

	const canRead = Boolean(context.tools?.some((tool) => tool.name === MORE_TOOL));
	const stubs = new Map<string, Message>();
	const stubFor = (message: Message & { role: 'toolResult' }) => {
		let made = stubs.get(message.toolCallId);
		if (!made) {
			const text = textOf(message);
			keepCleared(message.toolCallId, text);
			made = { ...message, content: [{ type: 'text', text: stub(message.toolName, message.toolCallId, text.length, canRead) }] };
			stubs.set(message.toolCallId, made);
		}
		return made;
	};

	const fixed = tokensOf((context.systemPrompt ?? '').length + JSON.stringify(context.tools ?? []).length);
	const sizes = context.messages.map((message) =>
		message.role === 'toolResult' && state.cleared.has(message.toolCallId) ? messageTokens(stubFor(message)) : messageTokens(message),
	);
	const sum = (from: number) => sizes.slice(from).reduce((total, size) => total + size, 0);
	// What the provider counted of the previous call, where this one starts as it did, and the messages since estimated.
	const last = state.sent;
	const counted =
		last?.tokens && last.fixed === fixed && last.messages <= context.messages.length && markOf(context.messages[last.messages - 1]) === last.mark ? last.tokens + sum(last.messages) : null;
	let tokens = counted ?? fixed + sum(0);
	state.sent = { call: state.calls, messages: context.messages.length, mark: markOf(context.messages.at(-1)), fixed, tokens: null };
	// Reasoning before the newest result cleared by an earlier batch was left out of what the provider counted.
	let dropped = -1;
	if (counted !== null && model.dropThinking) context.messages.forEach((message, index) => message.role === 'toolResult' && state.cleared.has(message.toolCallId) && (dropped = index));

	const { price } = model;
	const due = cold ? tokens > point * START : tokens > point * URGENT || (priced(price) && tokens > point * warmShare(price) && paysBack(state.calls, tokens, point, price));
	if (point > 0 && due) {
		// The newest results are kept, the one that crosses the line too.
		let recent = 0;
		const candidates: number[] = [];
		for (let index = context.messages.length - 1; index >= 0; index--) {
			const message = context.messages[index];
			if (message.role !== 'toolResult' || state.cleared.has(message.toolCallId)) continue;
			if (recent < PROTECT_TOKENS) recent += sizes[index];
			else if (textOf(message).length >= MIN_CHARS || sizes[index] >= tokensOf(MIN_CHARS)) candidates.unshift(index);
		}
		for (const index of candidates) {
			if (tokens <= point * TARGET) break;
			const message = context.messages[index] as Message & { role: 'toolResult' };
			state.cleared.add(message.toolCallId);
			const size = messageTokens(stubFor(message));
			tokens -= sizes[index] - size;
			sizes[index] = size;
		}
	}

	if (!state.cleared.size) return { context, cleared: 0, tokens, call: state.calls };
	// Old reasoning goes up to the newest cleared result, which moves only with a batch, so the calls between send the same start.
	let edge = -1;
	if (model.dropThinking) context.messages.forEach((message, index) => message.role === 'toolResult' && state.cleared.has(message.toolCallId) && (edge = index));
	const messages = context.messages.map((message, index) => {
		if (message.role === 'toolResult' && state.cleared.has(message.toolCallId)) return stubFor(message);
		if (index < edge && message.role === 'assistant' && Array.isArray(message.content)) {
			const kept = (message.content as Part[]).filter((part) => part.type !== 'thinking');
			if (kept.length && kept.length < message.content.length) {
				const without = { ...message, content: kept } as Message;
				if (index >= dropped) tokens -= messageTokens(message) - messageTokens(without);
				return without;
			}
		}
		return message;
	});
	return { context: { ...context, messages }, cleared: stubs.size, tokens, call: state.calls };
}

/**
 * What the provider counted of call `call` of conversation `key` (its input, read from the cache, written to it, or
 * neither), which sizes the conversation's next call. A count for any but its latest call, or of nothing (a call that
 * failed), is not kept.
 */
export function noteSent(key: string, call: number, usage: { input?: number; cacheRead?: number; cacheWrite?: number } | undefined): void {
	const sent = conversations.get(key)?.sent;
	const tokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
	if (sent?.call === call && tokens > 0) sent.tokens = tokens;
}

/** Forgets every conversation's clearing, as a restart does. */
export function resetPruning(): void {
	conversations.clear();
}
