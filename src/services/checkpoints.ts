import { createHash } from 'node:crypto';
import { listMachineFiles, readMachineFile } from '../core/machine-fs.ts';
import type { Machine, ObjectStore } from '../core/ports.ts';
import { text } from '../core/shell.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { type FileChange, type LogEntry, changes, repoDir } from './git.ts';

/** Larger files are listed but not copied. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

export type SavedFile = FileChange & { blob: string | null };
export type SavedOutput = { path: string; size: number; mtimeMs: number; key: string | null };

/** Everything needed to show a stopped task without its machine. */
export type Checkpoint = {
	at: string;
	baseSha: string;
	branch: string;
	files: SavedFile[];
	log: LogEntry[];
	outputs: SavedOutput[];
};

const keys = {
	latest: (id: string) => `sessions/${id}/checkpoint.json`,
	history: (id: string, at: string) => `sessions/${id}/checkpoints/${at}.json`,
	patch: (id: string) => `sessions/${id}/checkpoint.patch`,
	output: (id: string, path: string) => `sessions/${id}/outputs/${path}`,
	blob: (hash: string) => `blobs/${hash}`,
};

/** Content-addressed, so unchanged files across turns are stored once. */
async function saveBlob(store: ObjectStore, bytes: Uint8Array): Promise<string> {
	const key = keys.blob(createHash('sha256').update(bytes).digest('hex'));
	if (!(await store.has(key))) await store.put(key, bytes);
	return key;
}

async function saveFile(store: ObjectStore, machine: Machine, change: FileChange): Promise<SavedFile> {
	if (change.status === 'D') return { ...change, blob: null };
	const bytes = await readMachineFile(machine, `${repoDir(machine)}/${change.path}`);
	return { ...change, blob: bytes.length <= MAX_FILE_BYTES ? await saveBlob(store, bytes) : null };
}

/** Uploads outputs that are new or changed since the last checkpoint. */
async function syncOutputs(id: string, store: ObjectStore, machine: Machine, previous: SavedOutput[]): Promise<SavedOutput[]> {
	const seen = new Map(previous.map((output) => [output.path, output]));
	const files = await listMachineFiles(machine, `${machine.root}/outputs`);
	return Promise.all(
		files.map(async (file): Promise<SavedOutput> => {
			const before = seen.get(file.path);
			if (before && before.size === file.size && before.mtimeMs === file.mtimeMs) return before;
			if (file.size > MAX_OUTPUT_BYTES) return { ...file, key: null };
			const key = keys.output(id, file.path);
			await store.put(key, await readMachineFile(machine, `${machine.root}/outputs/${file.path}`));
			return { ...file, key };
		}),
	);
}

export async function readCheckpoint(id: string): Promise<Checkpoint | null> {
	const bytes = await getProviders().store.get(keys.latest(id));
	return bytes ? (JSON.parse(text(bytes)) as Checkpoint) : null;
}

export async function readCheckpointPatch(id: string): Promise<string> {
	const bytes = await getProviders().store.get(keys.patch(id));
	return bytes ? text(bytes) : '';
}

/** Records the task's current files, diff and outputs. Safe to call repeatedly. */
export async function saveCheckpoint(id: string, machine: Machine): Promise<Checkpoint> {
	const session = await getSessionRecord(id);
	if (!session) throw new Error(`Session ${id} not found`);
	const { store } = getProviders();
	const previous = await readCheckpoint(id);
	const diff = await changes(machine, session.baseSha);
	const checkpoint: Checkpoint = {
		at: new Date().toISOString(),
		baseSha: session.baseSha,
		branch: session.branch,
		files: await Promise.all(diff.files.map((change) => saveFile(store, machine, change))),
		log: diff.log,
		outputs: await syncOutputs(id, store, machine, previous?.outputs ?? []),
	};
	const manifest = JSON.stringify(checkpoint);
	await store.put(keys.patch(id), diff.patch, 'text/x-diff');
	await store.put(keys.history(id, checkpoint.at), manifest, 'application/json');
	await store.put(keys.latest(id), manifest, 'application/json');
	await updateSession(id, { checkpointAt: checkpoint.at });
	return checkpoint;
}

export async function readOutput(id: string, path: string): Promise<Uint8Array | null> {
	return getProviders().store.get(keys.output(id, path));
}

export async function readBlob(key: string): Promise<Uint8Array | null> {
	return getProviders().store.get(key);
}

/** Removes everything saved under the task. Blobs are shared between tasks, so they stay. */
export async function deleteCheckpoints(id: string): Promise<void> {
	const { store } = getProviders();
	const objects = await store.list(`sessions/${id}/`);
	await Promise.all(objects.map((object) => store.remove(object.key)));
}
