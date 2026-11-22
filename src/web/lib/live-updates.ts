import { focusManager, type Query, type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AgentNow, Session } from '@/lib/api/sessions';
import { taskQueries } from '@/lib/task-queries';

type Change =
	| { kind: 'sessions' }
	| { kind: 'task'; id: string; what: 'state' | 'usage' | 'files' | 'browser' | 'computer' | 'subagents' | 'todos' | 'scripts' | 'joins' | 'mail' | 'approvals' | 'pr-metadata' | 'settled' }
	| { kind: 'subscriptions' }
	| { kind: 'setup' }
	| { kind: 'connectors' }
	| { kind: 'models' }
	| { kind: 'spaces' }
	| { kind: 'space'; id: string; what: 'threads' | 'files' | 'settings' | 'todos' }
	| { kind: 'automations' }
	| { kind: 'notifications' }
	| { kind: 'projects' }
	| { kind: 'general' }
	| PageChange
	/** What a task's agent is doing this moment, sent whole as it changes too often to refetch. */
	| { kind: 'now'; id: string; now: AgentNow | null };

export type PageChange = { kind: 'page'; id: string; path: string; version: number; from: string };

const pageListeners = new Set<(change: PageChange) => void>();

export function onPageChange(listener: (change: PageChange) => void): () => void {
	pageListeners.add(listener);
	return () => void pageListeners.delete(listener);
}

/** The queries each change makes stale. Keys match by prefix, so ['file', id] covers every open file. */
export function staleFor(change: Exclude<Change, { kind: 'now' }>): QueryKey[] {
	// The pages themselves fetch their state; only the Artifacts page's edited times move.
	if (change.kind === 'page') return [['artifacts']];
	// A sign-in finishing, or a plan's models changing, changes what the model picker offers.
	if (change.kind === 'subscriptions') return [['subscriptions'], ['models'], ['connections'], ['health']];
	if (change.kind === 'setup') return [['setup'], ['connections'], ['subscriptions'], ['models'], ['health'], ['compute']];
	if (change.kind === 'models') return [['models']];
	if (change.kind === 'notifications') return [['notifications']];
	if (change.kind === 'projects') return [['projects']];
	if (change.kind === 'general') return [['general-settings']];
	if (change.kind === 'connectors') return [['connectors'], ['connections'], ['sealed-secrets']];
	if (change.kind === 'automations') return [['automations'], ['space-automations']];
	// Projects count their threads by state, and Reviews lists tasks by their pull request, so a change to any task can move them.
	if (change.kind === 'sessions') return [['sessions'], ['budget'], ['usage'], ['compute'], ['spaces'], ['space'], ['space-todos'], ['artifacts'], ['reviews']];
	if (change.kind === 'spaces') return [['spaces'], ['space']];
	if (change.kind === 'space' && change.what === 'files') return [['space-files', change.id]];
	if (change.kind === 'space' && change.what === 'todos') return [['space-todos', change.id]];
	if (change.kind === 'space' && change.what === 'settings') return [['spaces'], ['space', change.id], ['space-automations', change.id]];
	// A to-do's state follows its threads, so a change to them can move it.
	if (change.kind === 'space') return [['spaces'], ['space', change.id], ['sessions'], ['space-usage', change.id], ['space-todos', change.id]];
	if (change.kind === 'task' && change.what === 'browser') return [['browser', change.id]];
	if (change.kind === 'task' && change.what === 'computer') return [['computer', change.id]];
	if (change.kind === 'task' && change.what === 'subagents') return [['subagents', change.id]];
	if (change.kind === 'task' && change.what === 'scripts') return [['scripts', change.id]];
	if (change.kind === 'task' && change.what === 'todos') return [['todos', change.id]];
	if (change.kind === 'task' && change.what === 'joins') return [['joins', change.id]];
	if (change.kind === 'task' && change.what === 'mail') return [['mail', change.id]];
	if (change.kind === 'task' && change.what === 'approvals') return [['tool-approvals', change.id]];
	if (change.kind === 'task' && change.what === 'pr-metadata') return [['pr-metadata', change.id]];
	if (change.kind === 'task' && change.what === 'settled') return [['settled', change.id]];
	// A model turn ended: the context meter, and what the task and the day have spent, moved. Its tool calls send their own `files`.
	// The task's row in the list is read again on its own (`rowsFor`): a reply makes a model turn every few seconds.
	if (change.kind === 'task' && change.what === 'usage') return [['context', change.id], ['session', change.id], ['budget'], ['usage'], ['space-usage']];
	const files: QueryKey[] = [['changes', change.id], ['files', change.id], ['file', change.id], ['outputs', change.id], ['stored-outputs', change.id], ['previews', change.id], ['artifacts']];
	if (change.what === 'files') return files;
	return [
		['sessions'],
		['spaces'],
		['space'],
		['budget'],
		['usage'],
		// A reply's spend: which project it counts toward is the server's to know.
		['space-usage'],
		['compute'],
		['reviews'],
		['session', change.id],
		// A reply starting or ending reads the messages waiting for it, or drops them on a Stop.
		['waiting', change.id],
		['context', change.id],
		['checkpoints', change.id],
		['pull-request', change.id],
		['pulls', change.id],
		['pull', change.id],
		// The sandbox starting or stopping starts or ends its desktop.
		['computer', change.id],
		...files,
	];
}

/** Tasks whose row in the list a change moves, read alone and written into the list rather than reading the whole list again. */
export function rowsFor(change: Exclude<Change, { kind: 'now' }>): string[] {
	return change.kind === 'task' && change.what === 'usage' ? [change.id] : [];
}

/** Changes that land together refetch once. */
const SETTLE_MS = 300;

export function refetcher(queryClient: QueryClient) {
	const pending = new Map<string, QueryKey>();
	const rows = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	return (keys: QueryKey[], ids: string[] = []) => {
		for (const key of keys) pending.set(JSON.stringify(key), key);
		for (const id of ids) rows.add(id);
		timer ??= setTimeout(() => {
			timer = null;
			for (const key of pending.values()) void queryClient.invalidateQueries({ queryKey: key });
			pending.clear();
			const list = queryClient.getQueryData<{ sessions: Session[] }>(['sessions']);
			// Joins a read the invalidation above started for an open task; `keepTasksInStep` writes the answer into the list.
			for (const id of rows) if (list?.sessions.some((session) => session.id === id)) void queryClient.fetchQuery({ ...taskQueries.session(id), staleTime: 0 }).catch(() => undefined);
			rows.clear();
		}, SETTLE_MS);
	};
}

/** Back from this long away, a page reads again what it shows: a phone may have frozen the page and its stream meanwhile. */
export const AWAY_REFETCH_MS = 60_000;

/** `openedAt`: when the event stream last connected, or when the page came back from long enough away to doubt it. */
const stream = { open: false, openedAt: 0, hiddenAt: 0 };

/**
 * Reads the event stream keeps current: everything that changes them on the server sends an event, which marks them
 * stale at once. While the stream is up, a page that shows one reads the copy already here instead of asking again.
 * Data the server can change without an event (GitHub, the sandbox's files, the model catalog) is not in it.
 */
export const LIVE_KEYS: ReadonlySet<string> = new Set([
	'sessions',
	'session',
	'spaces',
	'space',
	'space-todos',
	'space-usage',
	'budget',
	'usage',
	'notifications',
	'setup',
	'connectors',
	'sealed-secrets',
	'subscriptions',
	'automations',
	'space-automations',
	'artifacts',
	'projects',
	'general-settings',
	'health',
	'context',
	'waiting',
	'checkpoints',
	'joins',
	'todos',
	'subagents',
	'scripts',
	'mail',
	'tool-approvals',
	'settled',
	// What a task saved (its checkpoint and kept files) changes only by its own writes, each sending `files` or `state`.
	'stored-outputs',
]);

/** A safety net for a change that sends no event (a day ending, a limit set on another device): kept reads are read again after this long. */
export const LIVE_FRESH_MS = 5 * 60_000;

/**
 * How long a read stays fresh. One the stream keeps current, read since it connected, stays fresh for `LIVE_FRESH_MS`
 * while the stream is up; anything else for `fallback`. An event, or the stream dropping, still reads it again.
 */
export function liveStaleTime(query: Pick<Query, 'queryKey' | 'state'>, fallback: number): number {
	const root = query.queryKey[0];
	if (!stream.open || typeof root !== 'string' || !LIVE_KEYS.has(root)) return fallback;
	return query.state.dataUpdatedAt >= stream.openedAt ? LIVE_FRESH_MS : fallback;
}

/** For tests: the stream as `useLiveUpdates` last saw it. */
export function setStreamForTest(open: boolean, openedAt = Date.now()) {
	stream.open = open;
	stream.openedAt = openedAt;
}

/** Coming back to the tab refetches only when changes may have been missed; while the stream is up its events kept the page current. */
export function refetchOnReturn(awayMs: number, streamOpen: boolean): boolean {
	return !streamOpen || awayMs >= AWAY_REFETCH_MS;
}

/** Replaces TanStack's refetch on every return to the tab. */
export function installReturnRefetch(): void {
	focusManager.setEventListener((handleFocus) => {
		const changed = () => {
			if (document.visibilityState === 'hidden') {
				stream.hiddenAt = Date.now();
				return;
			}
			if (refetchOnReturn(stream.hiddenAt ? Date.now() - stream.hiddenAt : 0, stream.open)) {
				// The stream may have been frozen with the page: what it kept current is read again, not trusted.
				stream.openedAt = Date.now();
				handleFocus();
			}
			stream.hiddenAt = 0;
		};
		document.addEventListener('visibilitychange', changed);
		return () => document.removeEventListener('visibilitychange', changed);
	});
}

/** Refetches just what the server says changed; after a dropped connection everything is refetched, since changes may have been missed. */
export function useLiveUpdates() {
	const queryClient = useQueryClient();
	useEffect(() => {
		const refetch = refetcher(queryClient);
		const events = new EventSource('/api/events');
		let dropped = false;
		events.onmessage = (event) => {
			const change = JSON.parse(event.data) as Change;
			if (change.kind === 'now') {
				queryClient.setQueryData(['now', change.id], { now: change.now });
				return;
			}
			if (change.kind === 'page') for (const listener of pageListeners) listener(change);
			refetch(staleFor(change), rowsFor(change));
		};
		events.onerror = () => {
			dropped = true;
			stream.open = false;
		};
		events.onopen = () => {
			if (dropped) void queryClient.invalidateQueries();
			dropped = false;
			stream.open = true;
			// Reads from before now may predate the events this stream will carry, so they are not kept on its word.
			stream.openedAt = Date.now();
		};
		return () => {
			stream.open = false;
			events.close();
		};
	}, [queryClient]);
}
