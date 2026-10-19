import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, isChat, type Reasoning } from '@/lib/api';
import type { FileAttachment, ImageAttachment } from '@/lib/attachments';
import { askToNotify } from '@/lib/notifications';
import { setPendingPrompt } from '@/lib/pending-prompt';
import { NO_REPO, rememberProject } from '@/lib/projects';
import { withAttachments } from '../../core/attachments';

function titleFrom(prompt: string): string {
	const line = prompt.trim().split('\n')[0] ?? '';
	return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/** Create a task on a repo and branch, or a chat without `projectId`, and open it; a prompt becomes its title and first message, with any files attached to it. */
export function useCreateChat() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			prompt: raw,
			images = [],
			files = [],
			...input
		}: {
			projectId?: string;
			branch?: string;
			model?: string;
			reasoning?: Reasoning;
			planMode?: boolean;
			prompt?: string;
			/** Sent with the first message, as the model sees images. */
			images?: ImageAttachment[];
			/** Saved to the new task's Library and read as text for the first message. */
			files?: FileAttachment[];
		}) => {
			askToNotify();
			const prompt = raw?.trim();
			const named = prompt || files[0]?.name || (images.length ? 'Look at the attached image' : '');
			// The start of the prompt names it until a fast model gives it a short title.
			const session = await api.createSession({ ...input, title: named ? titleFrom(named) : input.projectId ? 'New task' : 'New chat', ...(prompt ? { titleFrom: prompt } : {}) });
			rememberProject(input.projectId ?? NO_REPO);
			const attached = await Promise.all(files.map((file) => api.attachToTask(session.id, file.file)));
			const message = withAttachments(prompt || (images.length && !attached.length ? 'Look at the attached image.' : ''), attached, 'task');
			if (message) setPendingPrompt(session.id, message, images);
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
