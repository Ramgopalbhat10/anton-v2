import { announce } from '../core/changes.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { writeMachineFile } from '../core/machine-fs.ts';
import type { Machine } from '../core/ports.ts';
import { quote, safeRelativePath, text } from '../core/shell.ts';
import { getSessionRecord, listThreadRecords } from '../db/sessions.ts';
import { getSpace } from '../db/spaces.ts';
import { getProviders } from '../providers/index.ts';
import { MAX_UPLOAD_BYTES } from './files.ts';
import { logProblem } from './log.ts';
import { liveMachine } from './workspace.ts';

/**
 * Files you add to a project's Library: kept in the object store, and copied
 * into every thread's machine beside the repo, at `../project-files`, so each
 * thread can read them. A thread without a machine reads them with
 * `read_project_file` instead.
 */
const prefix = (spaceId: string) => `spaces/${spaceId}/files/`;
/** Where the files sit in a machine, beside the repo and the outputs. */
export const PROJECT_FILES = 'project-files';

export type SpaceFile = { path: string; size: number; modifiedAt: string };

async function existing(spaceId: string): Promise<void> {
	if (!(await getSpace(spaceId))) throw new NotFoundError('Project not found');
}

export async function listSpaceFiles(spaceId: string): Promise<SpaceFile[]> {
	await existing(spaceId);
	const objects = await getProviders().store.list(prefix(spaceId));
	return objects
		.map((object) => ({ path: object.key.slice(prefix(spaceId).length), size: object.size, modifiedAt: new Date(object.modifiedAt).toISOString() }))
		.filter((file) => file.path)
		.sort((a, b) => a.path.localeCompare(b.path));
}

const fileName = (name: string) => safeRelativePath(name.split(/[\\/]/).pop()?.replace(/[^\w.\- ]+/g, '_').trim() || 'file');

/** Each running machine of the project's threads, for copying a file in or out. */
async function liveThreadMachines(spaceId: string): Promise<Machine[]> {
	const threads = await listThreadRecords(spaceId);
	const machines = await Promise.all(threads.filter((thread) => thread.machineState).map((thread) => liveMachine(thread.id).catch(() => null)));
	return machines.filter((machine): machine is Machine => machine !== null);
}

export async function uploadSpaceFile(spaceId: string, name: string, bytes: Uint8Array, contentType?: string): Promise<SpaceFile> {
	await existing(spaceId);
	if (bytes.length > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be added to the Library.');
	const path = fileName(name);
	await getProviders().store.put(`${prefix(spaceId)}${path}`, bytes, contentType);
	for (const machine of await liveThreadMachines(spaceId)) {
		await writeInto(machine, path, bytes).catch((error: unknown) => logProblem('warn', 'Could not copy a project file into a thread', error));
	}
	announce({ kind: 'space', id: spaceId, what: 'files' });
	return { path, size: bytes.length, modifiedAt: new Date().toISOString() };
}

export async function removeSpaceFile(spaceId: string, rawPath: string): Promise<void> {
	await existing(spaceId);
	const path = safeRelativePath(rawPath);
	await getProviders().store.remove(`${prefix(spaceId)}${path}`);
	for (const machine of await liveThreadMachines(spaceId)) {
		await machine.exec(`rm -f ${quote(`${machine.root}/${PROJECT_FILES}/${path}`)}`).catch(() => undefined);
	}
	announce({ kind: 'space', id: spaceId, what: 'files' });
}

export async function readSpaceFile(spaceId: string, rawPath: string): Promise<Uint8Array | null> {
	return getProviders().store.get(`${prefix(spaceId)}${safeRelativePath(rawPath)}`);
}

async function writeInto(machine: Machine, path: string, bytes: Uint8Array): Promise<void> {
	await machine.exec(`mkdir -p ${quote(`${machine.root}/${PROJECT_FILES}`)}`);
	await writeMachineFile(machine, `${machine.root}/${PROJECT_FILES}/${path}`, bytes);
}

/** Puts a project's files into a thread's machine; run each time the machine is set up or resumed. */
export async function copySpaceFiles(machine: Machine, sessionId: string): Promise<void> {
	const session = await getSessionRecord(sessionId);
	if (!session?.spaceId) return;
	for (const file of await listSpaceFiles(session.spaceId)) {
		const bytes = await readSpaceFile(session.spaceId, file.path);
		if (bytes) await writeInto(machine, file.path, bytes);
	}
}

/** The longest text `read_project_file` returns at once. */
const MAX_READ = 60_000;

/** A project file as text, for a thread that has no machine yet: the list when no path is given. */
export async function readProjectFileForAgent(sessionId: string, rawPath?: string): Promise<string> {
	const session = await getSessionRecord(sessionId);
	if (!session?.spaceId) return 'This task is not part of a project, so it has no project files.';
	const files = await listSpaceFiles(session.spaceId);
	if (!rawPath) return files.length ? files.map((file) => `${file.path} (${file.size.toLocaleString()} bytes)`).join('\n') : 'The project has no files yet.';
	const bytes = await readSpaceFile(session.spaceId, rawPath);
	if (!bytes) return `No project file ${rawPath}. The files are:\n${files.map((file) => file.path).join('\n')}`;
	const content = text(bytes);
	return content.length > MAX_READ ? `${content.slice(0, MAX_READ)}\n… (cut at ${MAX_READ.toLocaleString()} characters)` : content;
}
