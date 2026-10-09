import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '@/lib/api';

/** Refetches every view of a task, for when its sandbox starts or stops. */
export function useRefreshTask(sessionId: string) {
	const queryClient = useQueryClient();
	return useCallback(
		() =>
			void queryClient.invalidateQueries({
				predicate: (query) => query.queryKey[0] === 'sessions' || query.queryKey.includes(sessionId),
			}),
		[queryClient, sessionId],
	);
}

/** Starts the task's sandbox, then refreshes every view of the task. */
export function useResume(sessionId: string) {
	return useMutation({ mutationFn: () => api.resumeSession(sessionId), onSettled: useRefreshTask(sessionId) });
}
