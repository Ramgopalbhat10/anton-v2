import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '@/lib/api';

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

export function useResume(sessionId: string) {
	return useMutation({ mutationFn: () => api.resumeSession(sessionId), onSettled: useRefreshTask(sessionId) });
}
