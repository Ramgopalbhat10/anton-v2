import type { AttachedFile } from '../core/attachments.ts';
import { NotFoundError } from '../core/errors.ts';
import { safeRelativePath } from '../core/shell.ts';
import { cachedDocumentText, documentKind, documentSlice } from './documents.ts';
import { readOutputFile, storedOutputs, uploadOutput } from './files.ts';
import { logProblem } from './log.ts';
import { uploadSpaceFile } from './space-files.ts';

/**
 * Files attached to a message from a composer. A task's go into its Library
 * under `uploads/` (and its sandbox's outputs folder, now or when it starts);
 * the coordinator's and a new thread's go into the project's Library, which
 * every thread reads. Each comes back with its text for the message, cut at
 * `INLINE_CHARS`; the agent reads the rest with `read_attachment` or
 * `read_project_file`.
 */
export const INLINE_CHARS = 20_000;

async function described(name: string, path: string, bytes: Uint8Array): Promise<AttachedFile> {
	const doc = await cachedDocumentText(name, bytes).catch((error: unknown) => {
		logProblem('warn', `Could not read ${name} as text`, error);
		return null;
	});
	const text = doc?.text ?? null;
	const cut = text !== null && text.length > INLINE_CHARS ? text.length : null;
	return { name, path, size: bytes.length, kind: doc?.kind ?? documentKind(name), text: cut ? text!.slice(0, INLINE_CHARS) : text, cut };
}

export async function attachToTask(id: string, name: string, bytes: Uint8Array, contentType?: string): Promise<AttachedFile> {
	const path = await uploadOutput(id, name, bytes, contentType);
	return described(path.slice(path.lastIndexOf('/') + 1), path, bytes);
}

export async function attachToProject(spaceId: string, name: string, bytes: Uint8Array, contentType?: string): Promise<AttachedFile> {
	const file = await uploadSpaceFile(spaceId, name, bytes, contentType);
	return described(file.path, file.path, bytes);
}

/** A file attached to one of the task's messages, as text from `offset`: for `read_attachment`. */
export async function readAttachment(id: string, rawPath: string, offset = 0): Promise<string> {
	// The agent may name it as its sandbox sees it, under the outputs folder.
	const path = safeRelativePath(rawPath.trim().replace(/^(\.\.\/)?outputs\//, ''));
	const bytes = await readOutputFile(id, path).catch((error: unknown) => (error instanceof NotFoundError ? null : Promise.reject(error)));
	if (!bytes) {
		const uploads = (await storedOutputs(id)).filter((output) => output.path.startsWith('uploads/')).map((output) => output.path);
		return `No attached file ${rawPath}.${uploads.length ? ` The attached files are:\n${uploads.join('\n')}` : ' No files are attached to this task.'}`;
	}
	return documentSlice(path.slice(path.lastIndexOf('/') + 1), bytes, offset, 'read the next part with read_attachment');
}
