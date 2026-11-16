import { announce } from '../../core/changes.ts';
import { InvalidInputError } from '../../core/errors.ts';
import { uniqueUploadNames } from '../../core/upload-name.ts';
import { saveOutput, savedOutputs } from '../git/checkpoints.ts';
import { MAX_UPLOAD_BYTES } from './files.ts';

// Kept as the Library of a holder that is no task, so Library reads and deletes work on them and storage cleanup never removes them.

/** Not a UUID, so never a task's id. */
export const ADDED_FILES = 'added-files';

export const isAddedFiles = (id: string) => id === ADDED_FILES;

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
