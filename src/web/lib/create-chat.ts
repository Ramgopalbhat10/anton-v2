import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '@/lib/api';
import { setPendingPrompt } from '@/lib/pending-prompt';

function titleFrom(prompt: string): string {
	const line = prompt.trim().split('\n')[0] ?? '';
	return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/** Create a session and open it; a prompt becomes its title and first message. */
export function useCreateChat() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (input?: { prompt?: string; model?: string }) => {
			const prompt = input?.prompt?.trim();
			const session = await api.createSession({
				title: prompt ? titleFrom(prompt) : 'New chat',
				model: input?.model,
			});
			if (prompt) setPendingPrompt(session.id, prompt);
			return session;
		},
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
