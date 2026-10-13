import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, isChat, type Reasoning } from '@/lib/api';
import { askToNotify } from '@/lib/notifications';
import { setPendingPrompt } from '@/lib/pending-prompt';
import { NO_REPO, rememberProject } from '@/lib/projects';

function titleFrom(prompt: string): string {
	const line = prompt.trim().split('\n')[0] ?? '';
	return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/** Create a task on a repo and branch, or a chat without `projectId`, and open it; a prompt becomes its title and first message. */
export function useCreateChat() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			prompt: raw,
			...input
		}: {
			projectId?: string;
			branch?: string;
			model?: string;
			reasoning?: Reasoning;
			planMode?: boolean;
			prompt?: string;
		}) => {
			askToNotify();
			const prompt = raw?.trim();
			const session = await api.createSession({ ...input, title: prompt ? titleFrom(prompt) : input.projectId ? 'New task' : 'New chat' });
			rememberProject(input.projectId ?? NO_REPO);
			if (prompt) setPendingPrompt(session.id, prompt);
			return session;
		},
		onSuccess: (session) => {
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			// A chat opens on the conversation alone; its workspace opens when the agent browses or you open it.
			void navigate({
				to: '/agents/$sessionId',
				params: { sessionId: session.id },
				search: { app: isChat(session) ? 'closed' : 'code' },
			});
		},
	});
}
