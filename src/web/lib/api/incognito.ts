import type { AttachedFile } from '../../../core/attachments';
import type { ModelRoute } from '../../../core/model-route';
import { json, post, request } from './http';
import type { Reasoning } from './plans';

export const incognitoApi = {
	/** An incognito chat's model choice, kept in memory only — there is no session record. */
	chooseIncognito: (id: string, choice: { model?: string; reasoning?: Reasoning | null; route?: ModelRoute | null }) =>
		post(`/api/incognito/${id}`, choice),
	/** A file attached to an incognito message: read as text for the message, never stored. */
	attachIncognito: (name: string, file: File) =>
		json<AttachedFile>(`/api/incognito/attach?name=${encodeURIComponent(name)}`, {
			method: 'POST',
			body: file,
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
		}),
	/** Stops an incognito reply and forgets the chat everywhere the agent keeps per-conversation state. `keepalive` lets it finish as the page closes. */
	closeIncognito: async (id: string) => void (await request(`/api/incognito/${id}`, { method: 'DELETE', keepalive: true })),
	stopIncognito: async (id: string) => void (await request(`/api/agents/incognito/${id}/abort`, { method: 'POST' })),
};
