import type { Context, Message, Model, Api } from '@earendil-works/pi-ai';
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
 * lost; after five minutes idle, when the cache has expired anyway, it
 * clears as soon as it passes the mark. Replayed on real tasks, clearing
 * sooner with a warm cache cost more in misses than it saved. What was cleared
 * stays cleared on every later call, so the cache holds between batches. The
 * runtime keeps the conversation itself whole: this only changes what is sent.
 */

/** Clearing starts past this share of where the agent compacts, */
const START = 0.5;
/** and while the provider's cache is warm, only past this share, in place of compacting soon, */
const URGENT = 0.85;
/** and stops at this share. */
const TARGET = 0.3;
/** The newest tool results the agent is likely still working from, which are never cleared. */
const PROTECT_TOKENS = 20_000;
/** A result this small costs little more than its stub. */
const MIN_CHARS = 2_000;
/** Providers keep a prompt cache about this long after its last use. */
const CACHE_MS = 5 * 60_000;
/** Conversations whose cleared results are remembered, the least recently called dropped first. */
const KEEP_CONVERSATIONS = 200;
/** What a picture counts for, about what providers charge for a screenshot. */
const IMAGE_TOKENS = 1_600;

type State = { cleared: Set<string>; lastAt: number | null };
const conversations = new Map<string, State>();

/** The runtime's rule of thumb for a size it does not measure. */
const tokensOf = (chars: number) => Math.ceil(chars / 4);

type Part = { type: string; text?: string; thinking?: string; arguments?: unknown };

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

export type Pruned = { context: Context; cleared: number; tokens: number };

/**
 * The context a model call sends for conversation `key` (the runtime's session id for it): its results cleared so
 * far given stubs, and a new batch cleared when it has grown past the mark.
 */
export function pruneContext(key: string, context: Context, point: number, now = Date.now()): Pruned {
	const state = conversations.get(key) ?? { cleared: new Set<string>(), lastAt: null };
	conversations.delete(key);
	conversations.set(key, state);
	if (conversations.size > KEEP_CONVERSATIONS) conversations.delete(conversations.keys().next().value!);
	const cold = state.lastAt === null || now - state.lastAt >= CACHE_MS;
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
	let tokens = fixed + sizes.reduce((sum, size) => sum + size, 0);

	if (point > 0 && tokens > point * (cold ? START : URGENT)) {
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

	if (!state.cleared.size) return { context, cleared: 0, tokens };
	const messages = context.messages.map((message) => (message.role === 'toolResult' && state.cleared.has(message.toolCallId) ? stubFor(message) : message));
	return { context: { ...context, messages }, cleared: stubs.size, tokens };
}

/** Forgets every conversation's clearing, as a restart does. */
export function resetPruning(): void {
	conversations.clear();
}
