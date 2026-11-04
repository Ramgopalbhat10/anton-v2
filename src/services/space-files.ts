import { uploadName } from '../core/upload-name.ts';
import { announce } from '../core/changes.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { listMachineFiles, readMachineFile, writeMachineFile } from '../core/machine-fs.ts';
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

const fileName = (name: string) => safeRelativePath(uploadName(name));

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
 * What a machine's `../project-files` held as last matched with the Library: each file's size and time in the
 * machine, and the Library copy's time then. Kept in the machine beside the folder, so it is gone exactly when
 * the folder is, and compares the machine's own clock with itself and the Library's with itself.
 */
type Seen = Record<string, { size: number; mtimeMs: number; libraryAt: number }>;

const seenFile = (machine: Machine) => `${machine.root}/.anton-project-files.json`;

async function readSeen(machine: Machine): Promise<Seen> {
	const result = await machine.exec(`cat ${quote(seenFile(machine))} 2>/dev/null`);
	if (result.exitCode !== 0) return {};
	try {
		return JSON.parse(new TextDecoder().decode(result.stdout)) as Seen;
	} catch {
		return {};
	}
}

const writeSeen = (machine: Machine, seen: Seen) => writeMachineFile(machine, seenFile(machine), new TextEncoder().encode(JSON.stringify(seen)));

/** One thread's copies in and out, one after another, so a save and a copy never read the same record at once. */
const syncing = new Map<string, Promise<unknown>>();

function oneAtATime<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
	const next = (syncing.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(work);
	syncing.set(sessionId, next);
	void next.finally(() => {
		if (syncing.get(sessionId) === next) syncing.delete(sessionId);
	}).catch(() => undefined);
	return next;
}

/** `notes/plan.md` as `notes/plan (Thread title).md`, for a change that met a newer one from another thread. */
function besideName(path: string, title: string): string {
	const slash = path.lastIndexOf('/');
	const dot = path.lastIndexOf('.');
	const [base, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
	const from = title.replace(/[^\w.\- ]+/g, '_').trim().slice(0, 40) || 'thread';
	return `${base} (${from})${ext}`;
}

/**
 * Saves what a thread added or changed in `../project-files` to the project's Library, so every thread,
 * now or later, starts with it: a journal kept day after day, a ledger, notes. A file is saved when it
 * differs from what the machine last matched with the Library; one changed in the Library by another thread
 * since is kept beside it under the thread's name instead, so neither change is lost. A file deleted in the
 * machine stays in the Library, which is where project files are deleted. Returns the paths saved.
 */
export function saveSpaceFiles(machine: Machine, sessionId: string): Promise<string[]> {
	return oneAtATime(sessionId, () => saveChanged(machine, sessionId));
}

async function saveChanged(machine: Machine, sessionId: string): Promise<string[]> {
	const session = await getSessionRecord(sessionId);
	if (!session?.spaceId) return [];
	const spaceId = session.spaceId;
	const [present, seen, library] = await Promise.all([listMachineFiles(machine, `${machine.root}/${PROJECT_FILES}`), readSeen(machine), listSpaceFiles(spaceId)]);
	const inLibrary = new Map(library.map((file) => [file.path, Date.parse(file.modifiedAt)]));
	const changed = present.filter((file) => {
		const before = seen[file.path];
		return !before || before.size !== file.size || before.mtimeMs !== file.mtimeMs;
	});
	if (!changed.length) return [];
	const saved: string[] = [];
	let matched = false;
	for (const file of changed) {
		let path: string;
		try {
			path = safeRelativePath(file.path);
		} catch {
			continue;
		}
		if (file.size > MAX_UPLOAD_BYTES) continue;
		const before = seen[file.path];
		const libraryAt = inLibrary.get(path);
		const bytes = await readMachineFile(machine, `${machine.root}/${PROJECT_FILES}/${file.path}`);
		let target = path;
		if (libraryAt !== undefined && libraryAt !== before?.libraryAt) {
			// The Library's copy changed since this machine last matched it, or the machine has no record of
			// matching it. The same bytes are a file put in from the Library, as an upload does; other bytes may
			// be another thread's save: keep both.
			const current = await readSpaceFile(spaceId, path);
			if (current && Buffer.from(current).equals(Buffer.from(bytes))) {
				seen[path] = { size: file.size, mtimeMs: file.mtimeMs, libraryAt };
				matched = true;
				continue;
			}
			target = besideName(path, session.title);
		}
		await getProviders().store.put(`${prefix(spaceId)}${target}`, bytes);
		saved.push(target);
		if (target === path) seen[path] = { size: file.size, mtimeMs: file.mtimeMs, libraryAt: Number.NaN };
	}
	if (!saved.length) {
		if (matched) await writeSeen(machine, seen);
		return [];
	}
	// The Library's times for what was just saved, so the next copy knows these are this machine's own.
	const after = new Map((await listSpaceFiles(spaceId)).map((file) => [file.path, Date.parse(file.modifiedAt)]));
	for (const path of saved) if (seen[path]) seen[path].libraryAt = after.get(path) ?? Number.NaN;
	await writeSeen(machine, seen);
	announce({ kind: 'space', id: spaceId, what: 'files' });
	return saved;
}

/**
 * Puts a project's files into a thread's machine; run each time the machine is set up or resumed, which is
 * every message to a thread with a sandbox. What the thread changed there is saved to the Library first, so a
 * copy never writes over it. A file the machine holds as it last matched the Library is left as it is, so a
 * running machine costs a listing rather than a copy of every file.
 */
export function copySpaceFiles(machine: Machine, sessionId: string): Promise<void> {
	return oneAtATime(sessionId, async () => {
		const session = await getSessionRecord(sessionId);
		if (!session?.spaceId) return;
		await saveChanged(machine, sessionId);
		const spaceId = session.spaceId;
		const dir = `${machine.root}/${PROJECT_FILES}`;
		// The folder is there even before the project has a file, so a thread can start one.
		await machine.exec(`mkdir -p ${quote(dir)}`);
		const [files, present, seen] = await Promise.all([listSpaceFiles(spaceId), listMachineFiles(machine, dir), readSeen(machine)]);
		const there = new Map(present.map((file) => [file.path, file]));
		const next: Seen = {};
		const written: string[] = [];
		for (const file of files) {
			const libraryAt = Date.parse(file.modifiedAt);
			const copy = there.get(file.path);
			const before = seen[file.path];
			if (copy && before && before.libraryAt === libraryAt && before.size === copy.size && before.mtimeMs === copy.mtimeMs) {
				next[file.path] = before;
				continue;
			}
			const bytes = await readSpaceFile(spaceId, file.path);
			if (!bytes) continue;
			await writeInto(machine, file.path, bytes);
			written.push(file.path);
			next[file.path] = { size: bytes.length, mtimeMs: 0, libraryAt };
		}
		// A file removed from the Library while this machine was away goes from the machine too, unless the
		// thread changed it since, in which case the save above put it back.
		const inLibrary = new Set(files.map((file) => file.path));
		const removed = present.filter((file) => !inLibrary.has(file.path) && seen[file.path]?.size === file.size && seen[file.path]?.mtimeMs === file.mtimeMs);
		if (removed.length) await machine.exec(`cd ${quote(dir)} && rm -f -- ${removed.map((file) => quote(file.path)).join(' ')}`);
		if (written.length) {
			// The times the machine gave the files just written, read back from it.
			const now = new Map((await listMachineFiles(machine, dir)).map((file) => [file.path, file]));
			for (const path of written) {
				const file = now.get(path);
				if (file) next[path] = { ...next[path], size: file.size, mtimeMs: file.mtimeMs };
			}
		}
		await writeSeen(machine, next);
	});
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
