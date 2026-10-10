import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

type Change =
	| { kind: 'sessions' }
	| { kind: 'task'; id: string; what: 'state' | 'files' | 'browser' | 'subagents' }
	| { kind: 'subscriptions' }
	| { kind: 'models' }
	| { kind: 'spaces' }
	| { kind: 'space'; id: string; what: 'threads' | 'files' | 'settings' };

/** The queries each change makes stale. Keys match by prefix, so ['file', id] covers every open file. */
function staleFor(change: Change): QueryKey[] {
	// A sign-in finishing, or a plan's models changing, changes what the model picker offers.
	if (change.kind === 'subscriptions') return [['subscriptions'], ['models'], ['connections']];
	if (change.kind === 'models') return [['models']];
	// Projects count their threads by state, so a change to any task can move a count.
	if (change.kind === 'sessions') return [['sessions'], ['budget'], ['usage'], ['compute'], ['spaces'], ['space']];
	if (change.kind === 'spaces') return [['spaces'], ['space']];
	if (change.kind === 'space' && change.what === 'files') return [['space-files', change.id]];
	if (change.kind === 'space' && change.what === 'settings') return [['spaces'], ['space', change.id], ['space-automations', change.id]];
	if (change.kind === 'space') return [['spaces'], ['space', change.id], ['sessions'], ['space-usage', change.id]];
	// The Browser panel's page moved, or the browser opened or closed.
	if (change.kind === 'task' && change.what === 'browser') return [['browser', change.id]];
	if (change.kind === 'task' && change.what === 'subagents') return [['subagents', change.id]];
	// A tool call can change files, and can start or stop a dev server.
	const files: QueryKey[] = [['changes', change.id], ['files', change.id], ['file', change.id], ['outputs', change.id], ['previews', change.id]];
	if (change.what === 'files') return files;
	return [
		['sessions'],
		['spaces'],
		['space'],
		['budget'],
		['usage'],
		['compute'],
		['session', change.id],
		['context', change.id],
		['checkpoints', change.id],
		['pull-request', change.id],
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
		events.onmessage = (event) => refetch(staleFor(JSON.parse(event.data) as Change));
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
