import { hashKey, type Query, QueryCache, QueryClient } from '@tanstack/react-query';
import type { Session } from '@/lib/api';

type List = { sessions: Session[] };

/** A task is read in the list and on its own; whichever read lands last is written into the other, so the header never lags the sidebar. */
export function keepTasksInStep(queryClient: QueryClient, data: unknown, query: Query<unknown, unknown, unknown>): void {
	const [key, id] = query.queryKey;
	if (key === 'sessions' && query.queryKey.length === 1) {
		for (const session of (data as List | undefined)?.sessions ?? []) {
			// Only a task open somewhere; one being read on its own already will be as new.
			// By its hash, a lookup rather than a scan of the cache, since this runs for every task in the list.
			const own = queryClient.getQueryCache().get(hashKey(['session', session.id]));
			if (!own?.state.data || own.state.fetchStatus === 'fetching') continue;
			queryClient.setQueryData(['session', session.id], session);
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

export function appQueryClient(): QueryClient {
	const queryClient: QueryClient = new QueryClient({
		queryCache: new QueryCache({ onSuccess: (data, query) => keepTasksInStep(queryClient, data, query) }),
	});
	return queryClient;
}
