import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AgentNow } from '@/lib/api';

type Change =
	| { kind: 'sessions' }
	| { kind: 'task'; id: string; what: 'state' | 'files' | 'browser' | 'computer' | 'subagents' | 'todos' | 'scripts' | 'joins' | 'mail' }
	| { kind: 'subscriptions' }
	| { kind: 'connectors' }
	| { kind: 'models' }
	| { kind: 'spaces' }
	| { kind: 'space'; id: string; what: 'threads' | 'files' | 'settings' }
	| { kind: 'automations' }
	| PageChange
	/** What a task's agent is doing this moment, sent whole as it changes too often to refetch. */
	| { kind: 'now'; id: string; now: AgentNow | null };

/** A copy of a page saved its state (src/services/renders.ts). */
export type PageChange = { kind: 'page'; id: string; path: string; version: number; from: string };

const pageListeners = new Set<(change: PageChange) => void>();

/** Calls `listener` whenever a page's state is saved, so a page shown here can fetch it; returns the function that stops it. */
export function onPageChange(listener: (change: PageChange) => void): () => void {
	pageListeners.add(listener);
	return () => void pageListeners.delete(listener);
}

/** The queries each change makes stale. Keys match by prefix, so ['file', id] covers every open file. */
function staleFor(change: Exclude<Change, { kind: 'now' }>): QueryKey[] {
	// The pages themselves fetch their state; only the Artifacts page's edited times move.
	if (change.kind === 'page') return [['artifacts']];
	// A sign-in finishing, or a plan's models changing, changes what the model picker offers.
	if (change.kind === 'subscriptions') return [['subscriptions'], ['models'], ['connections'], ['health']];
	if (change.kind === 'models') return [['models']];
	if (change.kind === 'connectors') return [['connectors'], ['connections']];
	// A routine added, edited or run: a repo's automations and a project's routines show it.
	if (change.kind === 'automations') return [['automations'], ['space-automations']];
	// Projects count their threads by state, and Reviews lists tasks by their pull request, so a change to any task can move them.
	if (change.kind === 'sessions') return [['sessions'], ['budget'], ['usage'], ['compute'], ['spaces'], ['space'], ['artifacts'], ['reviews']];
	if (change.kind === 'spaces') return [['spaces'], ['space']];
	if (change.kind === 'space' && change.what === 'files') return [['space-files', change.id]];
	if (change.kind === 'space' && change.what === 'settings') return [['spaces'], ['space', change.id], ['space-automations', change.id]];
	if (change.kind === 'space') return [['spaces'], ['space', change.id], ['sessions'], ['space-usage', change.id]];
	// The Browser panel's page moved, or the browser opened or closed.
	if (change.kind === 'task' && change.what === 'browser') return [['browser', change.id]];
	// The Computer panel's desktop started, or who drives it changed.
	if (change.kind === 'task' && change.what === 'computer') return [['computer', change.id]];
	if (change.kind === 'task' && change.what === 'subagents') return [['subagents', change.id]];
	// A run_script program called a tool: only its row in the thread reads it.
	if (change.kind === 'task' && change.what === 'scripts') return [['scripts', change.id]];
	// The agent wrote its todo list: only the pill above the composer reads it.
	if (change.kind === 'task' && change.what === 'todos') return [['todos', change.id]];
	if (change.kind === 'task' && change.what === 'joins') return [['joins', change.id]];
	// An email the agent asked to send was asked, sent or turned down: only its card reads it.
	if (change.kind === 'task' && change.what === 'mail') return [['mail', change.id]];
	// A tool call can change files, and can start or stop a dev server.
	const files: QueryKey[] = [['changes', change.id], ['files', change.id], ['file', change.id], ['outputs', change.id], ['previews', change.id], ['artifacts']];
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
		// A pull request opened, or its checks or review moved.
		['reviews'],
		['session', change.id],
		// A reply starting or ending reads the messages waiting for it, or drops them on a Stop.
		['waiting', change.id],
		['context', change.id],
		['checkpoints', change.id],
		['pull-request', change.id],
		// The PR panel: the task's pull requests, and the one open in it.
		['pulls', change.id],
		['pull', change.id],
		// The sandbox starting or stopping starts or ends its desktop.
		['computer', change.id],
		...files,
	];
}

/** Changes that land together refetch once. */
const SETTLE_MS = 300;

function refetcher(queryClient: QueryClient) {
	const pending = new Map<string, QueryKey>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	return (keys: QueryKey[]) => {
		for (const key of keys) pending.set(JSON.stringify(key), key);
		timer ??= setTimeout(() => {
			timer = null;
			for (const key of pending.values()) void queryClient.invalidateQueries({ queryKey: key });
			pending.clear();
		}, SETTLE_MS);
	};
}

/**
 * Listens for what changed on the server and refetches just that, so the
 * task list, a task's status and its files update as they happen. After a
 * dropped connection everything is refetched, since changes may have been missed.
 */
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
			refetch(staleFor(change));
		};
		events.onerror = () => {
			dropped = true;
		};
		events.onopen = () => {
			if (dropped) void queryClient.invalidateQueries();
			dropped = false;
		};
		return () => events.close();
	}, [queryClient]);
}
