import { createFlueClient, type FlueClient } from '@flue/sdk';
import type { UseFlueAgentResult } from '@flue/react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

/** Turns a conversation opens with, and fetched per page as you scroll up. */
export const WINDOW_TURNS = 10;

type Message = UseFlueAgentResult['messages'][number];

/** What the last history read said: its first message, and whether older turns come before it. */
type Opened = { first: string | null; older: boolean };

const opened = new Map<string, Opened>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => void listeners.delete(listener);
};
function note(path: string, value: Opened) {
	const current = opened.get(path);
	if (current?.first === value.first && current.older === value.older) return;
	opened.set(path, value);
	for (const listener of listeners) listener();
}

const pathOf = (input: RequestInfo | URL) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, globalThis.location?.origin);

/**
 * Asks Flue's history read for the latest turns only (`turns=`), and notes where they begin. A read again, after a
 * dropped connection, asks to start at the same message (`from=`), so the conversation shown never loses its start and
 * the older turns read before it still join up. Every other request, the live updates included, goes through
 * untouched. A server error falls back to the whole history, as before.
 */
export function windowedFetch(path: string, base: typeof fetch = (...args) => fetch(...args)): typeof fetch {
	let start: string | null = null;
	return async (input, init) => {
		const url = pathOf(input);
		if ((init?.method ?? 'GET') !== 'GET' || url.pathname !== path || url.searchParams.get('view') !== 'history') return base(input, init);
		url.searchParams.set('turns', String(WINDOW_TURNS));
		if (start) url.searchParams.set('from', start);
		let response = await base(url.href, init);
		if (response.status >= 500) response = await base(input, init);
		if (!response.ok) return response;
		const text = await response.text();
		try {
			const snapshot = JSON.parse(text) as { messages?: Message[]; window?: { before: string | null } };
			start = snapshot.messages?.[0]?.id ?? null;
			note(path, { first: start, older: Boolean(snapshot.window?.before) });
		} catch {
			// Flue reports what it cannot read.
		}
		return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
}

/** One conversation's client, opening at its latest turns. Made once per conversation, as Flue's hook asks. */
export function useWindowedClient(path: string): FlueClient {
	return useMemo(() => createFlueClient({ url: path, fetch: windowedFetch(path) }), [path]);
}

export type OlderTurns = {
	/** More turns come before what is shown. */
	more: boolean;
	loading: boolean;
	failed: boolean;
	load: () => void;
};

export type WindowedAgent = UseFlueAgentResult & { older?: OlderTurns };

type Pages = { anchor: string | null; messages: Message[]; done: boolean };
const NO_PAGES: Pages = { anchor: null, messages: [], done: false };

/** A file a message carries is read through the conversation, as Flue's client points the ones it loads. */
function withAttachmentUrls(message: Message, client: FlueClient): Message {
	let changed = false;
	const parts = message.parts.map((part) => {
		if (part.type === 'file' && 'id' in part && typeof part.id === 'string' && !('url' in part && part.url)) {
			changed = true;
			return { ...part, url: client.attachmentUrl(part.id) };
		}
		return part;
	});
	return changed ? ({ ...message, parts } as Message) : message;
}

/**
 * The conversation with the older turns you scrolled up to in front of it. Pages hang off the message the live
 * conversation starts with, which a read again keeps; once it starts elsewhere (rewound or compacted) they no longer
 * join up and are dropped, so nothing shows out of order or twice.
 */
export function useOlderTurns(path: string, client: FlueClient, agent: UseFlueAgentResult): WindowedAgent {
	const info = useSyncExternalStore(subscribe, () => opened.get(path));
	const live = agent.messages;
	const first = live[0]?.id ?? null;
	const [pages, setPages] = useState<Pages>(NO_PAGES);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const busy = useRef(false);
	const current = pages.anchor !== null && pages.anchor === first ? pages : NO_PAGES;
	const more = current !== NO_PAGES ? !current.done : Boolean(first && info?.first === first && info.older);

	useEffect(() => {
		setPages(NO_PAGES);
		setFailed(false);
	}, [path]);

	const load = useCallback(() => {
		if (busy.current || !more || !first) return;
		busy.current = true;
		setLoading(true);
		setFailed(false);
		const before = current.messages[0]?.id ?? first;
		void fetch(`${path}/older?before=${encodeURIComponent(before)}&turns=${WINDOW_TURNS}`)
			.then(async (response) => {
				if (response.status === 409) {
					// The conversation changed under the page; Flue reads it again on its next checkpoint.
					setPages({ anchor: first, messages: current.messages, done: true });
					return;
				}
				if (!response.ok) throw new Error(`older turns: ${response.status}`);
				const page = (await response.json()) as { messages: Message[]; before: string | null };
				setPages((previous) => {
					const kept = previous.anchor === first ? previous.messages : [];
					return { anchor: first, messages: [...page.messages.map((message) => withAttachmentUrls(message, client)), ...kept], done: page.before === null };
				});
			})
			.catch(() => setFailed(true))
			.finally(() => {
				busy.current = false;
				setLoading(false);
			});
	}, [more, first, current.messages, path, client]);

	const messages = useMemo(() => {
		if (!current.messages.length) return live;
		const shown = new Set(live.map((message) => message.id));
		return [...current.messages.filter((message) => !shown.has(message.id)), ...live];
	}, [current.messages, live]);

	const older = useMemo<OlderTurns>(() => ({ more, loading, failed, load }), [more, loading, failed, load]);
	return useMemo(() => ({ ...agent, messages, older }), [agent, messages, older]);
}
