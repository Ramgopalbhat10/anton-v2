import { type AttachedFile, splitAttachments } from '../../core/attachments.ts';
import { NotFoundError } from '../../core/errors.ts';
import { safeRelativePath } from '../../core/shell.ts';
import { cachedDocumentText, documentKind, documentSlice } from './documents.ts';
import { readOutputFile, storedOutputs, uploadOutput } from './files.ts';
import { logProblem } from '../../core/log.ts';
import type { DeliveredImage } from '../tasks/agent-runner.ts';
import { findModel } from '../models/models.ts';
import { describeImage } from '../models/vision.ts';
import { listSpaceFiles, readSpaceFile, uploadSpaceFile } from '../projects/space-files.ts';

/** A task's attachments go into its Library under `uploads/`; a project's into the project's Library. The message carries text up to this. */
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

const INCOGNITO_CHARS = 60_000;

/** Never stored, so there is no original for the agent to open and no read_attachment. */
export async function incognitoAttachment(name: string, bytes: Uint8Array): Promise<AttachedFile> {
	const doc = await cachedDocumentText(name, bytes).catch((error: unknown) => {
		logProblem('warn', `Could not read ${name} as text`, error);
		return null;
	});
	const full = doc?.text ?? null;
	const text = full === null ? null : full.length > INCOGNITO_CHARS ? `${full.slice(0, INCOGNITO_CHARS)}\n[The rest of this file is not included: incognito attachments are not stored.]` : full;
	return { name, path: name, size: bytes.length, kind: doc?.kind ?? documentKind(name), text, cut: null };
}

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

export async function projectAttachment(spaceId: string, rawName: string): Promise<AttachedFile> {
	const name = safeRelativePath(rawName.trim().replace(/^(\.\.\/)?project-files\//, ''));
	const bytes = await readSpaceFile(spaceId, name);
	if (!bytes) throw new NotFoundError(`No project file ${rawName}`);
	return described(name, name, bytes);
}

const MAX_THREAD_FILES = 10;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A thread sees nothing of the coordinator's conversation, so with none named the files the user attached to the message it answers go along. */
export async function filesForThread(spaceId: string, message: string, listed: string[] = [], answering = ''): Promise<string[]> {
	const clean = (name: string) => name.trim().replace(/^(\.\.\/)?project-files\//, '');
	const names = new Set(listed.map(clean).filter(Boolean));
	for (const file of await listSpaceFiles(spaceId)) {
		if (new RegExp(`(^|[^\\w.-])${escaped(file.path)}($|[^\\w-])`).test(message)) names.add(file.path);
	}
	if (!names.size) for (const file of splitAttachments(answering).files) if (file.place === 'project') names.add(file.path);
	return [...names].slice(0, MAX_THREAD_FILES);
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;

/** A model that cannot see gets each one described by the vision model instead, as a note. */
export async function projectPictures(spaceId: string, threadId: string, message: string, model: string): Promise<{ images: DeliveredImage[]; note: string }> {
	const typeOf = (name: string) => IMAGE_TYPES[/\.(\w+)$/.exec(name)?.[1]?.toLowerCase() ?? ''];
	const wanted = splitAttachments(message)
		.files.filter((file) => file.place === 'project' && typeOf(file.name))
		.slice(0, MAX_IMAGES);
	if (!wanted.length) return { images: [], note: '' };
	const sees = (await findModel(model).catch(() => undefined))?.vision === true;
	const images: DeliveredImage[] = [];
	const described: string[] = [];
	for (const file of wanted) {
		const bytes = await readSpaceFile(spaceId, file.path).catch(() => null);
		if (!bytes || bytes.length > MAX_IMAGE_BYTES) continue;
		const mimeType = typeOf(file.name)!;
		if (sees) images.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType, filename: file.name });
		else {
			const words = await describeImage(threadId, bytes, mimeType).catch((error: unknown) => {
				logProblem('warn', `Could not describe ${file.name}`, error, threadId);
				return null;
			});
			if (words) described.push(`${file.name}:\n${words}`);
		}
	}
	const note = described.length ? `Your model cannot see images, so a vision model described the attached ones:\n\n${described.join('\n\n')}` : '';
	return { images, note };
}
