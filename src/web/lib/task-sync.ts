import { hashKey, type Query, QueryCache, QueryClient } from '@tanstack/react-query';
import type { Session } from '@/lib/api/sessions';

type List = { sessions: Session[] };

/** A list row with the open task's whole texts where the row cut them and they still begin the same; a changed text stays cut, and named so, until the task is read again. */
export function withWholeText(row: Session, own: Session): Session {
	if (!row.cut?.length) return row;
	const whole: Session = { ...row };
	const cut = row.cut.filter((field) => {
		const text = own[field];
		const shown = row[field];
		if (typeof text !== 'string' || typeof shown !== 'string' || !text.startsWith(shown)) return true;
		whole[field] = text;
		return false;
	});
	if (cut.length) whole.cut = cut;
	else delete whole.cut;
	return whole;
}

/** A task is read in the list and on its own; whichever read lands last is written into the other, so the header never lags the sidebar. */
export function keepTasksInStep(queryClient: QueryClient, data: unknown, query: Query<unknown, unknown, unknown>): void {
	const [key, id] = query.queryKey;
	if (key === 'sessions' && query.queryKey.length === 1) {
		for (const session of (data as List | undefined)?.sessions ?? []) {
			// Only a task open somewhere; one being read on its own already will be as new.
			// By its hash, a lookup rather than a scan of the cache, since this runs for every task in the list.
			const own = queryClient.getQueryCache().get(hashKey(['session', session.id]));
			if (!own?.state.data || own.state.fetchStatus === 'fetching') continue;
			queryClient.setQueryData(['session', session.id], withWholeText(session, own.state.data as Session));
		}
	}
	if (key === 'session' && typeof id === 'string' && query.queryKey.length === 2 && data) {
		const listing = queryClient.getQueryCache().get(hashKey(['sessions']));
		if (!listing?.state.data || listing.state.fetchStatus === 'fetching') return;
		const session = data as Session;
		queryClient.setQueryData<List>(['sessions'], (list) =>
			list?.sessions.some((item) => item.id === id) ? { ...list, sessions: list.sessions.map((item) => (item.id === id ? session : item)) } : list,
		);
	}
}

/** How long an answer serves another reader of the same query without asking again. */
export const MOUNT_FRESH_MS = 5_000;

export function appQueryClient(): QueryClient {
	const queryClient: QueryClient = new QueryClient({
		queryCache: new QueryCache({ onSuccess: (data, query) => keepTasksInStep(queryClient, data, query) }),
		// Server events mark what changed stale whatever this says; it only stops readers that mount together on a page from each reading again.
		defaultOptions: { queries: { staleTime: MOUNT_FRESH_MS } },
	});
	return queryClient;
}
