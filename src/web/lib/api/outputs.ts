import type { AttachedFile } from '../../../core/attachments';
import { json, request } from './http';
import type { Source } from './workspace';

export type Output = { path: string; size: number; mtimeMs: number };
/** The owner of files you add on the Artifacts page, which belong to no task. */
export const ADDED_FILES = 'added-files';
export type Artifact = Output & { sessionId: string; title: string; task: { title: string; spaceId: string | null; chat: boolean }; /** You added it on the Artifacts page, so it is from no task. */ added?: boolean };
export type OutputsPayload = { source: Source; at: string | null; outputs: Output[]; /** Files you deleted from the Library, which replies show as deleted. */ deleted: string[] };

export const outputUrl = (id: string, path: string) => `/api/sessions/${id}/output?path=${encodeURIComponent(path)}`;

/** Ids asked for in the same moment, read together; each caller gets its own task's list. */
let batch: Map<string, { resolve: (value: { outputs: Output[] }) => void; reject: (error: unknown) => void }[]> | null = null;
const BATCH_MAX = 50;

function flush() {
	const asked = batch;
	batch = null;
	if (!asked) return;
	const ids = [...asked.keys()];
	for (let start = 0; start < ids.length; start += BATCH_MAX) {
		const part = ids.slice(start, start + BATCH_MAX);
		json<{ outputs: Record<string, Output[]> }>(`/api/outputs?ids=${part.map(encodeURIComponent).join(',')}`).then(
			(answer) => part.forEach((id) => asked.get(id)?.forEach((caller) => caller.resolve({ outputs: answer.outputs[id] ?? [] }))),
			(error) => part.forEach((id) => asked.get(id)?.forEach((caller) => caller.reject(error))),
		);
	}
}

/**
 * A task's saved Library, read together with every other task asked for in the same moment: a project listing its
 * threads' files makes one request, not one per thread. The task's own Library panel reads `outputs`, which also says
 * whether its sandbox runs.
 */
export function storedOutputs(id: string): Promise<{ outputs: Output[] }> {
	return new Promise((resolve, reject) => {
		if (!batch) {
			batch = new Map();
			setTimeout(flush, 0);
		}
		batch.set(id, [...(batch.get(id) ?? []), { resolve, reject }]);
	});
}

export const outputsApi = {
	outputs: (id: string) => json<OutputsPayload>(`/api/sessions/${id}/outputs`),
	storedOutputs,
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
