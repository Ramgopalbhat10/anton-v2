import type { AttachedFile } from '../../../core/attachments';
import { json, request } from './http';
import type { Source } from './workspace';

export type Output = { path: string; size: number; mtimeMs: number };
/** The owner of files you add on the Artifacts page, which belong to no task. */
export const ADDED_FILES = 'added-files';
export type Artifact = Output & { sessionId: string; title: string; task: { title: string; spaceId: string | null; chat: boolean }; /** You added it on the Artifacts page, so it is from no task. */ added?: boolean };
export type OutputsPayload = { source: Source; at: string | null; outputs: Output[]; /** Files you deleted from the Library, which replies show as deleted. */ deleted: string[] };

export const outputUrl = (id: string, path: string) => `/api/sessions/${id}/output?path=${encodeURIComponent(path)}`;

export const outputsApi = {
	outputs: (id: string) => json<OutputsPayload>(`/api/sessions/${id}/outputs`),
	artifacts: () => json<{ artifacts: Artifact[] }>('/api/artifacts'),
	downloadArtifacts: async (items: { sessionId: string; path: string }[]) =>
		(await request('/api/artifacts/download', { method: 'POST', body: JSON.stringify({ items }) })).blob(),
	addArtifact: (file: File) =>
		json<{ path: string; sessionId: string }>(`/api/artifacts?name=${encodeURIComponent(file.name)}`, {
			method: 'POST',
			body: file,
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
		}),
	outputText: async (id: string, path: string) => (await request(outputUrl(id, path))).text(),
	/** Adds a file to the task's Library, under uploads/. */
	uploadOutput: (id: string, file: File) =>
		json<{ path: string }>(`/api/sessions/${id}/outputs?name=${encodeURIComponent(file.name)}`, {
			method: 'POST',
			body: file,
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
		}),
	attachToTask: (id: string, file: File) =>
		json<AttachedFile>(`/api/sessions/${id}/attachments?name=${encodeURIComponent(file.name)}`, {
			method: 'POST',
			body: file,
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
		}),
	deleteOutput: async (id: string, path: string) => void (await request(outputUrl(id, path), { method: 'DELETE' })),
};
