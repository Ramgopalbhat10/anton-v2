import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, type ChangesScope, refreshFor } from '@/lib/api';
import { parsePatch } from '@/lib/diff';

/** One query per scope, so the tab count and the panel agree. The count is always the unpushed work, so it reads 0 once a pull request has it all. */
export function useChanges(sessionId: string, scope: ChangesScope = 'unpushed') {
	const changes = useQuery({
		queryKey: ['changes', sessionId, scope],
		queryFn: () => api.changes(sessionId, scope),
		refetchInterval: (query) => refreshFor(query.state.data?.source),
	});
	const files = useMemo(() => (changes.data ? parsePatch(changes.data.patch) : []), [changes.data]);
	return { changes, files };
}
