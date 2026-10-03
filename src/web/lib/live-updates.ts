import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

type Change = { kind: 'sessions' } | { kind: 'task'; id: string; what: 'state' | 'files' };

/** The queries each change makes stale. Keys match by prefix, so ['file', id] covers every open file. */
function staleFor(change: Change): QueryKey[] {
	if (change.kind === 'sessions') return [['sessions'], ['budget']];
	// A tool call can change files, and can start or stop a dev server.
	const files: QueryKey[] = [['changes', change.id], ['files', change.id], ['file', change.id], ['outputs', change.id], ['previews', change.id]];
	if (change.what === 'files') return files;
	return [
		['sessions'],
		['budget'],
		['session', change.id],
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
