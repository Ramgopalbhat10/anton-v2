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
export type ReplyOptions = { chars?: number; ms?: number; text?: string };

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

/** A coordinator's last turn passes a follow-up to a thread, so its quiet pill (`NoteRow`) shows on a project page. */
function coordinatorTurn(): Message[] {
	const message = 'New follow-up from the user: check whether the new library can render interactive UI in chat replies. Pull the latest main first and record the commit you inspected. Compare it with the current visual reply pipeline, not the older snapshot: feasibility, interactivity and state, streaming, security boundaries, dependencies and maturity. Analysis only: no implementation, dependency installs, code edits or pull request.';
	return [
		{ id: 'cu', role: 'user', purpose: 'user', display: 'visible', submissionId: 'sc', parts: [text('Check if this new library can be used for rendering interactive UI in the chat. Analysis only.')] },
		{
			id: 'ca',
			role: 'assistant',
			purpose: 'assistant',
			display: 'visible',
			submissionId: 'sc',
			parts: [
				{ type: 'dynamic-tool', toolName: 'message_thread', toolCallId: 'fixture-message', state: 'output-available', input: { thread: 'th-api', message }, output: 'Sent' },
				text('I passed it to the thread; it will pull the latest main and compare the library with the current pipeline, analysis only.'),
			],
		},
	];
}

/** With `?approvals`, a reply whose connector calls wait on Run (`tool_wait`) and ran already (`tool_ran`); the mocked API answers both. */
function approvalTurn(): Message[] {
	const tool = (toolCallId: string, toolName: string, output: string): Part => ({ type: 'dynamic-tool', toolName, toolCallId, state: 'output-available', input: {}, output });
	return [
		{ id: 'tu', role: 'user', purpose: 'user', display: 'visible', submissionId: 'st', parts: [text('Build the synthetic news demo in Databricks.')] },
		{
			id: 'ta',
			role: 'assistant',
			purpose: 'assistant',
			display: 'visible',
			submissionId: 'st',
			parts: [
				tool('t-list', 'connector_tools', 'Databricks: on'),
				text('I checked the workspace and ran the first statement.'),
				tool('t-ran', 'composio__databricks__sql_statement_exec_execute_statement', 'Waiting on Run. [approval:tool_ran]'),
				tool('t-read', 'read', 'ok'),
				text('The schema exists. The next statement creates the bronze table.'),
				tool('t-wait', 'composio__databricks__sql_statement_exec_execute_statement', 'Waiting on Run. [approval:tool_wait]'),
			],
		},
	];
}

function turnsFromUrl(): number {
	const turns = Number(new URLSearchParams(location.search).get('turns') ?? 8);
	return Number.isFinite(turns) && turns >= 0 ? Math.min(Math.floor(turns), 200) : 8;
}

export function createFlueClient({ url }: { url: string }) {
	const turns = turnsFromUrl();
	let conversation: Conversation = {
		conversationId: url,
		messages: [...startingTurns(turns), ...(url.includes('/coordinator/') ? coordinatorTurn() : []), ...(new URLSearchParams(location.search).has('approvals') ? approvalTurn() : [])],
		settlements: [...Array.from({ length: turns }, (_, index) => ({ submissionId: `s${index}`, outcome: 'completed' })), { submissionId: 'st', outcome: 'completed' }],
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
	function stream(submissionId: string, { chars = 3000, ms = 3000, text: body }: ReplyOptions = {}): Promise<void> {
		const id = `reply-${submissionId}`;
		const whole = body ?? answerText(chars);
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

	function send(body: string, reply?: ReplyOptions, submissionId = `sent-${++sent}`, pictures: object[] = []): { submissionId: string; done: Promise<void> } {
		publish({ ...conversation, messages: [...conversation.messages, { id: `user-${submissionId}`, role: 'user', purpose: 'user', display: 'visible', submissionId, parts: [text(body), ...pictures] }] });
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
		send: async ({ message }: { message: { body?: string; attachments?: Array<{ data: string; mimeType: string; filename?: string }> } }) => {
			// The reply starts a beat later, as the runtime's would.
			const submissionId = `sent-${++sent}`;
			// Pictures come back as the runtime stores them: at a URL of their own, which takes a moment to load.
			const pictures = await Promise.all(
				(message.attachments ?? []).map(async (image, index) => {
					const name = `${submissionId}-${index}-${image.filename ?? 'image.png'}`;
					const url = `/api/fixture/attachments/${encodeURIComponent(name)}`;
					await fetch(url, { method: 'POST', body: Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0)), headers: { 'content-type': image.mimeType } });
					return { type: 'file', mediaType: image.mimeType, url, filename: image.filename };
				}),
			);
			setTimeout(() => void send(message.body ?? '', undefined, submissionId, pictures), 150);
			return { submissionId };
		},
	};
}
