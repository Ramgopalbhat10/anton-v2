import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { api, type ModelRoute, type Reasoning } from '@/lib/api';
import type { FileAttachment, ImageAttachment } from '@/lib/attachments';
import { askToNotify } from '@/lib/notifications';
import { setPendingPrompt } from '@/lib/pending-prompt';
import { NO_REPO, rememberProject } from '@/lib/projects';
import { draftSession, madeAlready, newTaskId, startInBackground, titleFrom } from '@/lib/starting';
import { withAttachments } from '../../core/attachments';

export type NewChat = {
	projectId?: string;
	/** `owner/name` of the repository, for the task's row while it is made. */
	repo?: string;
	branch?: string;
	model?: string;
	reasoning?: Reasoning;
	route?: ModelRoute | null;
	planMode?: boolean;
	prompt?: string;
	/** Sent with the first message, as the model sees images. */
	images?: ImageAttachment[];
	/** Saved to the new task's Library and read as text for the first message. */
	files?: FileAttachment[];
};

/**
 * Creates a task on a repo and branch, or a chat without `projectId`, and opens it at once: its page shows it as a
 * skeleton while the server makes it. A prompt becomes its title and first message, with any files attached to it.
 */
export function useCreateChat(): (chat: NewChat) => void {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	return useCallback(
		({ prompt: raw, images = [], files = [], repo, ...input }: NewChat) => {
			askToNotify();
			const id = newTaskId();
			const prompt = raw?.trim() ?? '';
			const named = prompt || files[0]?.name || (images.length ? 'Look at the attached image' : '');
			// The start of the prompt names it until a fast model gives it a short title.
			const title = named ? titleFrom(named) : input.projectId ? 'New task' : 'New chat';
			const draft = draftSession({ id, title, prompt: named, projectId: input.projectId, repo, branch: input.branch, model: input.model ?? '', reasoning: input.reasoning, planMode: input.planMode });
			startInBackground(queryClient, draft, prompt, async () => {
				const session = await api
					.createSession({ id, ...input, title, ...(prompt ? { titleFrom: prompt } : {}) })
					.catch((error: unknown) => madeAlready(id, error, api.session));
				rememberProject(input.projectId ?? NO_REPO);
				const attached = await Promise.all(files.map((file) => api.attachToTask(session.id, file.file)));
				const message = withAttachments(prompt || (images.length && !attached.length ? 'Look at the attached image.' : ''), attached, 'task');
				if (message) setPendingPrompt(session.id, message, images);
				return session;
			});
			// A chat opens on the conversation alone; its workspace opens when the agent browses or you open it.
			void navigate({ to: '/agents/$sessionId', params: { sessionId: id }, search: { app: input.projectId ? 'code' : 'closed' } });
		},
		[navigate, queryClient],
	);
}
