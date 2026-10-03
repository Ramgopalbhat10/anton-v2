import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, type Reasoning } from '@/lib/api';
import { askToNotify } from '@/lib/notifications';
import { setPendingPrompt } from '@/lib/pending-prompt';
import { rememberProject } from '@/lib/projects';

function titleFrom(prompt: string): string {
	const line = prompt.trim().split('\n')[0] ?? '';
	return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/** Create a task on a repo and branch and open it; a prompt becomes its title and first message. */
export function useCreateChat() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ prompt: raw, ...input }: { projectId: string; branch?: string; model?: string; reasoning?: Reasoning; prompt?: string }) => {
			askToNotify();
			const prompt = raw?.trim();
			const session = await api.createSession({ ...input, title: prompt ? titleFrom(prompt) : 'New task' });
			rememberProject(input.projectId);
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
