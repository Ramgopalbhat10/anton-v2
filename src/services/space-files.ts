import { announce } from '../core/changes.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { listMachineFiles, writeMachineFile } from '../core/machine-fs.ts';
import type { Machine } from '../core/ports.ts';
import { quote, safeRelativePath } from '../core/shell.ts';
import { getSessionRecord, listThreadRecords } from '../db/sessions.ts';
import { getSpace } from '../db/spaces.ts';
import { getProviders } from '../providers/index.ts';
import { documentSlice } from './documents.ts';
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
	const target = `${machine.root}/${PROJECT_FILES}/${path}`;
	// A file can sit in a folder, as a deleted thread's kept files do.
	await machine.exec(`mkdir -p ${quote(target.slice(0, target.lastIndexOf('/')))}`);
	await writeMachineFile(machine, target, bytes);
}

/** The folder a deleted thread's files are kept in, named for it as the Library names its folder under From threads. */
export const keptFolder = (title: string) => `From threads/${title.replace(/[^\w.\- ]+/g, '_').trim() || 'Untitled'}`;

/**
 * Keeps the files a deleted thread saved in its Library, which go with it
 * otherwise, as project files in a folder named for it: they stay where the
 * project's Library showed them, and every thread can read them. Threads
 * running now get them when their sandbox is next set up; until then
 * `read_project_file` reads them.
 */
export async function keepThreadFiles(spaceId: string, title: string, files: Array<{ path: string; bytes: Uint8Array }>): Promise<string[]> {
	if (!files.length) return [];
	const existing = (await listSpaceFiles(spaceId)).map((file) => file.path);
	// A thread deleted earlier under the same title kept its files there: these get a folder of their own.
	let folder = keptFolder(title);
	for (let n = 2; existing.some((path) => path.startsWith(`${folder}/`)); n += 1) folder = `${keptFolder(title)} ${n}`;
	const kept: string[] = [];
	for (const file of files) {
		const path = safeRelativePath(`${folder}/${file.path}`);
		await getProviders().store.put(`${prefix(spaceId)}${path}`, file.bytes);
		kept.push(path);
	}
	announce({ kind: 'space', id: spaceId, what: 'files' });
	return kept;
}

/**
 * Puts a project's files into a thread's machine; run each time the machine is set up or resumed, which is
 * every message to a thread with a sandbox. A file the machine already holds, as large and written since the
 * Library's copy changed, is left as it is, so a running machine costs one listing rather than a copy of every file.
 */
export async function copySpaceFiles(machine: Machine, sessionId: string): Promise<void> {
	const session = await getSessionRecord(sessionId);
	if (!session?.spaceId) return;
	const [files, present] = await Promise.all([listSpaceFiles(session.spaceId), listMachineFiles(machine, `${machine.root}/${PROJECT_FILES}`)]);
	const there = new Map(present.map((file) => [file.path, file]));
	for (const file of files) {
		const copy = there.get(file.path);
		if (copy && copy.size === file.size && copy.mtimeMs >= Date.parse(file.modifiedAt)) continue;
		const bytes = await readSpaceFile(session.spaceId, file.path);
		if (bytes) await writeInto(machine, file.path, bytes);
	}
}

/** A project file as text from `offset`, PDFs and office documents converted: the list when no path is given. */
export async function readSpaceFileForAgent(spaceId: string, rawPath?: string, offset = 0): Promise<string> {
	const files = await listSpaceFiles(spaceId);
	if (!rawPath) return files.length ? files.map((file) => `${file.path} (${file.size.toLocaleString()} bytes)`).join('\n') : 'The project has no files yet.';
	const path = rawPath.trim().replace(new RegExp(`^(\\.\\./)?${PROJECT_FILES}/`), '');
	const bytes = await readSpaceFile(spaceId, path);
	if (!bytes) return `No project file ${rawPath}. The files are:\n${files.map((file) => file.path).join('\n')}`;
	return documentSlice(path, bytes, offset, 'read the next part with read_project_file');
}

/** The same for a project's thread, which may have no machine yet. */
export async function readProjectFileForAgent(sessionId: string, rawPath?: string, offset = 0): Promise<string> {
	const session = await getSessionRecord(sessionId);
	if (!session?.spaceId) return 'This task is not part of a project, so it has no project files.';
	return readSpaceFileForAgent(session.spaceId, rawPath, offset);
}
