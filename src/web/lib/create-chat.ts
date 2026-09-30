import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '@/lib/api';

export function useCreateChat() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (projectId?: string) => api.createSession({ title: 'New chat', projectId }),
		onSuccess: (session) => {
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			void navigate({
				to: '/agents/$sessionId',
				params: { sessionId: session.id },
				search: { app: 'code' },
			});
		},
	});
}
