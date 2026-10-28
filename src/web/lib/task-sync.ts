import { type Query, QueryCache, QueryClient } from '@tanstack/react-query';
import type { Session } from '@/lib/api';

type List = { sessions: Session[] };

/**
 * A task is read two ways: in the list (the sidebar, a project's threads) and
 * on its own (its page's header, thread and composer). Whichever read lands
 * last is written into the other, so the header never shows a title or a
 * Working the sidebar has moved on from because its own read was dropped or
 * came back slower.
 */
export function keepTasksInStep(queryClient: QueryClient, data: unknown, query: Query<unknown, unknown, unknown>): void {
	const [key, id] = query.queryKey;
	if (key === 'sessions' && query.queryKey.length === 1) {
		for (const session of (data as List | undefined)?.sessions ?? []) {
			// Only a task open somewhere; one being read on its own already will be as new.
			const own = queryClient.getQueryCache().find({ queryKey: ['session', session.id], exact: true });
			if (!own?.state.data || own.state.fetchStatus === 'fetching') continue;
			queryClient.setQueryData(['session', session.id], session);
		}
	}
	if (key === 'session' && typeof id === 'string' && query.queryKey.length === 2 && data) {
		const listing = queryClient.getQueryCache().find({ queryKey: ['sessions'], exact: true });
		if (!listing?.state.data || listing.state.fetchStatus === 'fetching') return;
		const session = data as Session;
		queryClient.setQueryData<List>(['sessions'], (list) =>
			list?.sessions.some((item) => item.id === id) ? { ...list, sessions: list.sessions.map((item) => (item.id === id ? session : item)) } : list,
		);
	}
}

/** The app's query client, with a task's two reads kept in step. */
export function appQueryClient(): QueryClient {
	const queryClient: QueryClient = new QueryClient({
		queryCache: new QueryCache({ onSuccess: (data, query) => keepTasksInStep(queryClient, data, query) }),
	});
	return queryClient;
}
