import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { taskQueries } from '@/lib/task-queries';

/** When Stop was pressed on this page, and when the server answered it; null once a later reply has started. */
type Stopped = { at: number; answeredAt: number | null } | null;
const NONE: Stopped = null;

const key = (sessionId: string) => ['stopped', sessionId] as const;

export function markStopped(queryClient: QueryClient, sessionId: string): void {
	queryClient.setQueryData<Stopped>(key(sessionId), () => ({ at: Date.now(), answeredAt: null }));
}

export function markStopAnswered(queryClient: QueryClient, sessionId: string): void {
	queryClient.setQueryData<Stopped>(key(sessionId), (stopped) => (stopped ? { ...stopped, answeredAt: Date.now() } : NONE));
}

export function clearStopped(queryClient: QueryClient, sessionId: string): void {
	queryClient.setQueryData<Stopped>(key(sessionId), () => NONE);
}

/**
 * True from the moment Stop is pressed until a later reply starts, so the composer and the header leave the running
 * state at once instead of waiting for the live stream and the task's next read to catch up. A reply that starts
 * after the stop clears it on the server (`stoppedAt`), so a read of the task made after Stop answered that shows it
 * working with no stop is a new reply; sending a message clears it here first.
 */
export function useStopped(sessionId: string): boolean {
	const queryClient = useQueryClient();
	const stopped = useQuery<Stopped>({ queryKey: key(sessionId), queryFn: () => NONE, enabled: false, staleTime: Infinity, initialData: NONE }).data ?? null;
	const session = useQuery(taskQueries.session(sessionId));
	const restarted = Boolean(stopped?.answeredAt && session.dataUpdatedAt > stopped.answeredAt && session.data?.working && !session.data.stoppedAt);
	useEffect(() => {
		if (restarted) clearStopped(queryClient, sessionId);
	}, [restarted, queryClient, sessionId]);
	return stopped !== null && !restarted;
}

/** The agent's status with a stop this page made: running reads as idle until a later reply starts. */
export function afterStop<T extends string>(status: T, stopped: boolean): T | 'idle' {
	return stopped && (status === 'submitted' || status === 'streaming') ? 'idle' : status;
}
