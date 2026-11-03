import { announce } from '../core/changes.ts';
import { InvalidInputError } from '../core/errors.ts';
import { uniqueUploadNames } from '../core/upload-name.ts';
import { saveOutput, savedOutputs } from './checkpoints.ts';
import { MAX_UPLOAD_BYTES } from './files.ts';

/*
 * Files you add on the Artifacts page yourself, such as a skill's SKILL.md,
 * kept beside what the agent made so any task can be given one as context
 * (the composer's + › From Artifacts). They are stored as the Library of a
 * holder that is no task, `ADDED_FILES`, so the Library's reads, previews
 * and deletes work on them as they are; storage cleanup never removes them,
 * since it only removes what a deleted task left.
 */

/** Not a UUID, so never a task's id. */
export const ADDED_FILES = 'added-files';

export const isAddedFiles = (id: string) => id === ADDED_FILES;

/** Adds a file under a name of its own: one already taken gets -2, -3 and so on. */
export async function addFile(name: string, bytes: Uint8Array, contentType?: string): Promise<string> {
	if (bytes.length > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be added.');
	const taken = new Set((await savedOutputs(ADDED_FILES)).map((output) => output.path));
	const path = uniqueUploadNames([...taken, name]).at(-1)!;
	await saveOutput(ADDED_FILES, path, bytes, contentType);
	announce({ kind: 'task', id: ADDED_FILES, what: 'files' });
	return path;
}

export async function addedFiles() {
	return (await savedOutputs(ADDED_FILES)).map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs }));
}
