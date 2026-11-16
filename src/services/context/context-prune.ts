import type { Context, Message, Model, Api } from '@earendil-works/pi-ai';
import { DEFAULT_CACHE_MS } from '../../core/prompt-cache.ts';
import { compactionReserve } from './context-usage.ts';
import { compactionCeiling } from '../models/general.ts';
import { keepCleared, MORE_TOOL } from './tool-results.ts';

/*
 * Clears old tool results from what a call sends (the runtime keeps the conversation whole), so compaction comes later.
 * Clearing misses the prompt cache once, so it goes in batches and stays cleared. With a warm cache it waits for 85% of
 * the compaction point, or for `warmShare` where prices pay a batch back within `PAYBACK_CALLS` (at 90% cache discounts a
 * replay spent 11-13% less on input; at DeepSeek's 98% it spent 9% more). Past the cache lifetime it clears at 50%.
 * A conversation idle 3 h is cleared at any size: in 18 days of tasks OpenAI's cache held on 1 call in 3 up to three hours
 * later, never past. Size is the provider's count of the last call plus 4 chars a token since. Reasoning before the newest
 * cleared result is dropped too where the API allows (not the Responses API).
 */

/** Clearing starts past this share of where the agent compacts, */
const START = 0.5;
/** and while the provider's cache is warm, only past this share, in place of compacting soon, */
const URGENT = 0.85;
/** and stops at this share. */
const TARGET = 0.3;
/** The newest results, which the agent is likely still working from, are never cleared. */
const PROTECT_TOKENS = 20_000;
const PAYBACK_CALLS = 25;
const MIN_CHARS = 2_000;
/** Picked up with no cache and for something new, so its results are cleared at any size. */
const STALE_MS = 3 * 60 * 60_000;
const KEEP_CONVERSATIONS = 200;
/** About what providers charge for a screenshot. */
const IMAGE_TOKENS = 1_600;

/** `mark` is the last message, `fixed` the system prompt and tools' size, `tokens` what the provider counted. */
type Sent = { call: number; messages: number; mark: string; fixed: number; tokens: number | null };
type State = { cleared: Set<string>; lastAt: number | null; calls: number; sent: Sent | null };
const conversations = new Map<string, State>();

/** The runtime's rule of thumb for a size it does not measure. */
const tokensOf = (chars: number) => Math.ceil(chars / 4);

type Part = { type: string; text?: string; thinking?: string; arguments?: unknown };

export type Price = { input: number; cacheRead: number; cacheWrite: number };
/** `cacheMs`: how long the provider's cache lasts after its last use (`cacheLifetime` in src/core/prompt-cache.ts; five minutes when not given). */
export type PruneModel = { price?: Price; dropThinking?: boolean; cacheMs?: number };

const missPrice = (price: Price) => Math.max(price.input, price.cacheWrite || 0) - price.cacheRead;
const priced = (price: Price | undefined): price is Price => Boolean(price && price.cacheRead > 0 && price.input > price.cacheRead);

/** Between half and 85%: where clearing down to 30% pays back its miss within `PAYBACK_CALLS`. Without prices (a plan), 85%. */
export function warmShare(price?: Price): number {
	if (!priced(price)) return URGENT;
	return Math.min(URGENT, Math.max(START, TARGET * (1 + missPrice(price) / (price.cacheRead * PAYBACK_CALLS))));
}

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

/** Settings › General's Compact at, or where the runtime would. */
export function compactionPoint(model: Pick<Model<Api>, 'contextWindow' | 'maxTokens'>, ceiling = compactionCeiling()): number {
	const window = model.contextWindow;
	return window > 0 ? window - compactionReserve(window, model.maxTokens || null, ceiling) : 0;
}

const markOf = (message: Message | undefined) => (message ? `${message.role}:${message.timestamp}:${message.role === 'toolResult' ? message.toolCallId : ''}` : '');

/** Read off its messages, since what this file remembers is lost in a restart. */
function pickedUpStale(messages: Message[], now: number): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === 'user') continue;
		return message.timestamp > 0 && now - message.timestamp >= STALE_MS;
	}
	return false;
}

export type Pruned = { context: Context; cleared: number; tokens: number; call: number };

/** `key` is the runtime's session id for the conversation. */
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
	const stale = pickedUpStale(context.messages, now);
	const due = stale || (cold ? tokens > point * START : tokens > point * URGENT || (priced(price) && tokens > point * warmShare(price) && paysBack(state.calls, tokens, point, price)));
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
			if (!stale && tokens <= point * TARGET) break;
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

/** Each one replaces the one before (`useProjectState` in src/agents/coordinator.ts). */
export const STATE_SIGNAL = 'project-state';
const STATE_OPEN = `<signal type="${STATE_SIGNAL}">`;
const STATE_GONE = `${STATE_OPEN}\nAn earlier state of the project, left out: the latest one is the project now.\n</signal>`;

const isState = (message: Message) => message.role === 'user' && (typeof message.content === 'string' ? message.content : ((message.content as Part[]).find((part) => part.type === 'text')?.text ?? '')).startsWith(STATE_OPEN);

/** A coordinator is told the project's state after each change, and one project's conversation held 91 of them, 89K of its 161K tokens. Only the latest is kept whole. */
export function latestStateOnly(context: Context): Context {
	let latest = -1;
	let earlier = false;
	for (let index = context.messages.length - 1; index >= 0; index--) {
		if (!isState(context.messages[index])) continue;
		if (latest < 0) latest = index;
		else {
			earlier = true;
			break;
		}
	}
	if (!earlier) return context;
	const messages = context.messages.map((message, index) => (index < latest && isState(message) ? ({ ...message, content: [{ type: 'text', text: STATE_GONE }] } as Message) : message));
	return { ...context, messages };
}

/** A count for any but its latest call, or of nothing (a call that failed), is not kept. */
export function noteSent(key: string, call: number, usage: { input?: number; cacheRead?: number; cacheWrite?: number } | undefined): void {
	const sent = conversations.get(key)?.sent;
	const tokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
	if (sent?.call === call && tokens > 0) sent.tokens = tokens;
}

export function resetPruning(): void {
	conversations.clear();
}
