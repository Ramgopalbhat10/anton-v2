/**
 * Stands in for `@flue/sdk` in the UI fixture (`npm run ui:fixture`): every
 * conversation the page opens (a task's, an incognito chat's, a project
 * coordinator's) is a scripted one that starts with long turns and answers
 * whatever is sent with a reply that streams for a few seconds. The real
 * `@flue/react` and the real components run on top, so the page lays out,
 * scrolls and streams as in production, with no server, keys or sandbox.
 *
 * The URL picks the start: `?turns=0` for an empty chat, `?turns=20` for a
 * longer one (8 by default). A script drives the latest conversation the page
 * opened through `window.__chat` (see `ChatControls`).
 */
import { answerText } from '../perf/scenario.ts';

type Part = Record<string, unknown> & { type: string };
type Message = { id: string; role: string; purpose: string; display: string; submissionId?: string; parts: Part[]; metadata?: Record<string, unknown> };
type Conversation = { conversationId: string; messages: Message[]; settlements: Array<{ submissionId: string; outcome: string }> };
type Snapshot = { conversation: Conversation; offset: string; phase: 'live'; error: undefined };

/** How a script drives the conversation, from the page (`page.evaluate(() => window.__chat.reply())`). */
export type ChatControls = {
	/** Sends a user message, as the composer does, and streams the reply; resolves once it settles. */
	send: (text?: string, reply?: ReplyOptions) => Promise<void>;
	/** Streams an assistant reply with no user message before it; resolves once it settles. */
	reply: (options?: ReplyOptions) => Promise<void>;
	/** Whether a reply is still streaming. */
	streaming: () => boolean;
	/** The conversation's URL and its message count. */
	info: () => { url: string; messages: number; streaming: boolean };
};
export type ReplyOptions = { chars?: number; ms?: number };

declare global {
	interface Window {
		__chat?: ChatControls;
	}
}

/** One stream chunk every this many milliseconds. */
const CHUNK_MS = 40;

const text = (value: string, state = 'done'): Part => ({ type: 'text', text: value, state });

function startingTurns(count: number): Message[] {
	return Array.from({ length: count }, (_, index) => [
		{ id: `u${index}`, role: 'user', purpose: 'user', display: 'visible', submissionId: `s${index}`, parts: [text(`Question ${index + 1}: how does this part work?`)] },
		{ id: `a${index}`, role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: `s${index}`, parts: [text(`${answerText(2400)}\n\nEnd of answer ${index + 1}.`)] },
	]).flat();
}

function turnsFromUrl(): number {
	const turns = Number(new URLSearchParams(location.search).get('turns') ?? 8);
	return Number.isFinite(turns) && turns >= 0 ? Math.min(Math.floor(turns), 200) : 8;
}

export function createFlueClient({ url }: { url: string }) {
	const turns = turnsFromUrl();
	let conversation: Conversation = {
		conversationId: url,
		messages: startingTurns(turns),
		settlements: Array.from({ length: turns }, (_, index) => ({ submissionId: `s${index}`, outcome: 'completed' })),
	};
	let snapshot: Snapshot = { conversation, offset: '0', phase: 'live', error: undefined };
	const listeners = new Set<() => void>();
	let sent = 0;
	let live = 0;
	const publish = (next: Conversation) => {
		conversation = next;
		snapshot = { conversation, offset: String(conversation.messages.length), phase: 'live', error: undefined };
		for (const listener of listeners) listener();
	};
	const setReply = (id: string, value: string, state: string) =>
		publish({ ...conversation, messages: conversation.messages.map((message) => (message.id === id ? { ...message, parts: [text(value, state)] } : message)) });

	/** Streams a reply to `submissionId` in even chunks over `ms`, then settles it. */
	function stream(submissionId: string, { chars = 3000, ms = 3000 }: ReplyOptions = {}): Promise<void> {
		const id = `reply-${submissionId}`;
		const whole = answerText(chars);
		const chunks = Math.max(1, Math.round(ms / CHUNK_MS));
		live++;
		publish({ ...conversation, messages: [...conversation.messages, { id, role: 'assistant', purpose: 'assistant', display: 'visible', submissionId, parts: [] }] });
		return new Promise((resolve) => {
			let chunk = 0;
			const timer = setInterval(() => {
				chunk++;
				const done = chunk >= chunks;
				setReply(id, whole.slice(0, Math.ceil((whole.length * chunk) / chunks)), done ? 'done' : 'streaming');
				if (!done) return;
				clearInterval(timer);
				live--;
				publish({ ...conversation, settlements: [...conversation.settlements, { submissionId, outcome: 'completed' }] });
				resolve();
			}, CHUNK_MS);
		});
	}

	function send(body: string, reply?: ReplyOptions, submissionId = `sent-${++sent}`): { submissionId: string; done: Promise<void> } {
		publish({ ...conversation, messages: [...conversation.messages, { id: `user-${submissionId}`, role: 'user', purpose: 'user', display: 'visible', submissionId, parts: [text(body)] }] });
		return { submissionId, done: stream(submissionId, reply) };
	}

	const controls: ChatControls = {
		send: (body = 'Another question about this.', reply) => send(body, reply).done,
		reply: (options) => stream(`reply-only-${++sent}`, options),
		streaming: () => live > 0,
		info: () => ({ url, messages: conversation.messages.length, streaming: live > 0 }),
	};

	return {
		observe: () => ({
			subscribe: (listener: () => void) => {
				listeners.add(listener);
				// The conversation the page shows now is the one a script drives.
				window.__chat = controls;
				return () => listeners.delete(listener);
			},
			getSnapshot: () => snapshot,
			refresh: () => undefined,
			close: () => listeners.clear(),
		}),
		send: async ({ message }: { message: { body?: string } }) => {
			// The reply starts a beat later, as the runtime's would.
			const submissionId = `sent-${++sent}`;
			setTimeout(() => void send(message.body ?? '', undefined, submissionId), 150);
			return { submissionId };
		},
	};
}
