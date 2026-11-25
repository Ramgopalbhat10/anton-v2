import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { stoppingNow } from '@/lib/now-text';

/**
 * After Stop answers, when the page still shows the reply running it reads the conversation again, then once more
 * later. Stop answers once the reply has settled, so a page still running then has a live stream that fell behind,
 * and it kept the composer on "Waiting on the browser agent" long after the server had stopped.
 */
export const CATCH_UP_MS = [1_000, 5_000] as const;

export function useStopCatchUp(sessionId: string, busy: boolean, refresh: () => void) {
	const queryClient = useQueryClient();
	const busyNow = useRef(busy);
	busyNow.current = busy;
	const refreshNow = useRef(refresh);
	refreshNow.current = refresh;
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
	useEffect(() => {
		const pending = timers.current;
		return () => pending.forEach(clearTimeout);
	}, []);
	return useCallback(
		async (stop: () => Promise<void>) => {
			// Said at once; the server says the same to every other page, then that the reply has settled.
			queryClient.setQueryData(['now', sessionId], { now: stoppingNow() });
			try {
				await stop();
			} catch (error) {
				void queryClient.invalidateQueries({ queryKey: ['now', sessionId] });
				throw error;
			}
			for (const ms of CATCH_UP_MS) {
				timers.current.push(
					setTimeout(() => {
						if (!busyNow.current) return;
						refreshNow.current();
						void queryClient.invalidateQueries({ queryKey: ['now', sessionId] });
						void queryClient.invalidateQueries({ queryKey: ['subagents', sessionId] });
					}, ms),
				);
			}
		},
		[queryClient, sessionId],
	);
}
