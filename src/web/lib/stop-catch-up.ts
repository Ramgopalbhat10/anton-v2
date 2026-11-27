import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { stoppingNow } from '@/lib/now-text';
import { clearStopped, markStopAnswered, markStopped } from '@/lib/stopped';
import { readTaskAgain, showStopped } from '@/lib/working';

/**
 * Stop shows at once: the composer and the header leave the running state (`useStopped`) and the task reads as
 * stopped wherever it is listed. Once Stop answers, the reply has settled on the server, so the page reads the task
 * and the conversation again, then once more later: a live stream that fell behind kept the thread on "Waiting on the
 * browser agent" long after the server had stopped.
 */
export const CATCH_UP_MS = [1_000, 5_000] as const;

export function useStopCatchUp(sessionId: string, refresh: () => void) {
	const queryClient = useQueryClient();
	const refreshNow = useRef(refresh);
	refreshNow.current = refresh;
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
	useEffect(() => {
		const pending = timers.current;
		return () => pending.forEach(clearTimeout);
	}, []);
	return useCallback(
		async (stop: () => Promise<void>) => {
			markStopped(queryClient, sessionId);
			queryClient.setQueryData(['now', sessionId], { now: stoppingNow() });
			void showStopped(queryClient, sessionId);
			try {
				await stop();
			} catch (error) {
				clearStopped(queryClient, sessionId);
				readTaskAgain(queryClient, sessionId);
				void queryClient.invalidateQueries({ queryKey: ['now', sessionId] });
				throw error;
			}
			markStopAnswered(queryClient, sessionId);
			readTaskAgain(queryClient, sessionId);
			for (const ms of CATCH_UP_MS) {
				timers.current.push(
					setTimeout(() => {
						refreshNow.current();
						readTaskAgain(queryClient, sessionId);
						void queryClient.invalidateQueries({ queryKey: ['now', sessionId] });
						void queryClient.invalidateQueries({ queryKey: ['subagents', sessionId] });
					}, ms),
				);
			}
		},
		[queryClient, sessionId],
	);
}
