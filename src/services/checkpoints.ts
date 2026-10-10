import { createHash } from 'node:crypto';
import { listMachineFiles, readMachineFile, writeMachineFile } from '../core/machine-fs.ts';
import type { Machine, ObjectStore } from '../core/ports.ts';
import { quote, run, text } from '../core/shell.ts';
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
	/** Lines added and removed against the base; absent on checkpoints saved before it was kept. */
	stats?: { added: number; removed: number };
};

/** Counts a patch's added and removed lines, skipping the file headers. */
function statsOf(patch: string): { added: number; removed: number } {
	const lines = patch.split('\n');
	const count = (sign: string, header: string) => lines.filter((line) => line.startsWith(sign) && !line.startsWith(header)).length;
	return { added: count('+', '+++'), removed: count('-', '---') };
}

const keys = {
	latest: (id: string) => `sessions/${id}/checkpoint.json`,
	history: (id: string, at: string) => `sessions/${id}/checkpoints/${at}.json`,
	historyPatch: (id: string, at: string) => `sessions/${id}/checkpoints/${at}.patch`,
	patch: (id: string) => `sessions/${id}/checkpoint.patch`,
	output: (id: string, path: string) => `sessions/${id}/outputs/${path}`,
	/** Outputs saved straight to storage, not through the machine's outputs folder. */
	saved: (id: string) => `sessions/${id}/saved-outputs.json`,
	blob: (hash: string) => `blobs/${hash}`,
};

/** Content-addressed, so unchanged files across turns are stored once. */
async function saveBlob(store: ObjectStore, bytes: Uint8Array): Promise<string> {
	const key = keys.blob(createHash('sha256').update(bytes).digest('hex'));
	if (!(await store.has(key))) await store.put(key, bytes);
	return key;
}

export const SYMLINK_MODE = '120000';

/** A symlink is saved as its target, never followed: it may point at a directory or nowhere. */
async function saveFile(store: ObjectStore, machine: Machine, change: FileChange): Promise<SavedFile> {
	if (change.status === 'D') return { ...change, blob: null };
	const path = `${repoDir(machine)}/${change.path}`;
	const bytes = change.mode === SYMLINK_MODE ? (await machine.exec(`readlink -n -- ${quote(path)}`)).stdout : await readMachineFile(machine, path);
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

/** Identifies the files and commits a checkpoint holds, ignoring when it was taken. */
const stateOf = (checkpoint: Checkpoint) => JSON.stringify([checkpoint.files, checkpoint.log.map((entry) => entry.sha)]);

/** Checkpoints being written, and the blob sweep that holds new ones back while it runs. */
let writing = 0;
let sweep: Promise<unknown> | null = null;

/**
 * Runs `work` while no checkpoint is being written. A checkpoint reuses blobs
 * it finds already stored, so a sweep running alongside could remove one it
 * is about to point at.
 */
export async function whileNoCheckpointIsWritten<T>(work: () => Promise<T>): Promise<T> {
	while (sweep) await sweep.catch(() => undefined);
	const run = (async () => {
		while (writing > 0) await new Promise((resolve) => setTimeout(resolve, 50));
		return work();
	})();
	sweep = run;
	try {
		return await run;
	} finally {
		sweep = null;
	}
}

/** Records the task's current files, diff and outputs. Safe to call repeatedly. */
export function saveCheckpoint(id: string, machine: Machine): Promise<Checkpoint> {
	return asWrite(() => writeCheckpoint(id, machine));
}

/** Runs `work` as a checkpoint write, which a blob sweep waits for. */
async function asWrite<T>(work: () => Promise<T>): Promise<T> {
	// Checked and counted in the same tick, so a sweep starting now waits for this one.
	while (sweep) await sweep.catch(() => undefined);
	writing++;
	try {
		return await work();
	} finally {
		writing--;
	}
}

async function writeCheckpoint(id: string, machine: Machine): Promise<Checkpoint> {
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
		stats: statsOf(diff.patch),
	};
	const manifest = JSON.stringify(checkpoint);
	await store.put(keys.patch(id), diff.patch, 'text/x-diff');
	// The timeline keeps one entry per distinct state, not one per response.
	if (!previous || stateOf(previous) !== stateOf(checkpoint)) {
		await store.put(keys.historyPatch(id, checkpoint.at), diff.patch, 'text/x-diff');
		await store.put(keys.history(id, checkpoint.at), manifest, 'application/json');
	}
	await store.put(keys.latest(id), manifest, 'application/json');
	await updateSession(id, { checkpointAt: checkpoint.at });
	return checkpoint;
}

/**
 * Gives another task the files of this task's latest checkpoint, as its own
 * first checkpoint. Blobs are shared, so nothing is copied but the manifest
 * and the diff; outputs stay with the original. Null when there is none.
 */
export function copyCheckpoint(from: string, to: string): Promise<Checkpoint | null> {
	return asWrite(() => writeCopy(from, to));
}

async function writeCopy(from: string, to: string): Promise<Checkpoint | null> {
	const [source, target] = await Promise.all([readCheckpoint(from), getSessionRecord(to)]);
	if (!source || !target) return null;
	const { store } = getProviders();
	const copy: Checkpoint = { ...source, at: new Date().toISOString(), branch: target.branch, log: [], outputs: [] };
	const manifest = JSON.stringify(copy);
	const patch = await readCheckpointPatch(from);
	await store.put(keys.patch(to), patch, 'text/x-diff');
	await store.put(keys.historyPatch(to, copy.at), patch, 'text/x-diff');
	await store.put(keys.history(to, copy.at), manifest, 'application/json');
	await store.put(keys.latest(to), manifest, 'application/json');
	await updateSession(to, { checkpointAt: copy.at });
	return copy;
}

/** Runs `command` over the paths in batches, so a long list never overflows the command line. */
export async function eachBatch(machine: Machine, command: string, paths: string[]): Promise<void> {
	for (let start = 0; start < paths.length; start += 200) {
		const batch = paths.slice(start, start + 200).map(quote).join(' ');
		await run(machine, `${command} -- ${batch}`, { cwd: repoDir(machine) });
	}
}

/**
 * Writes one file as saved: a symlink as a link, an executable with its bit.
 * Whatever is at the path goes first, so a write never follows a symlink out
 * of place, and an empty directory left by the reset makes way for the file.
 */
async function writeFile(machine: Machine, path: string, file: SavedFile, bytes: Uint8Array): Promise<void> {
	const dir = path.slice(0, path.lastIndexOf('/'));
	await run(machine, `mkdir -p ${quote(dir)} && { if [ -d ${quote(path)} ] && [ ! -L ${quote(path)} ]; then rmdir ${quote(path)}; else rm -f ${quote(path)}; fi; }`);
	if (file.mode === SYMLINK_MODE) {
		await run(machine, `ln -s -- "$(cat)" ${quote(path)}`, { stdin: bytes });
		return;
	}
	await writeMachineFile(machine, path, bytes);
	if (file.mode === '100755') await run(machine, `chmod +x ${quote(path)}`);
}

/** Writes the checkpoint's version of each file; returns those too large to have been saved. */
export async function applyFiles(machine: Machine, files: SavedFile[]): Promise<string[]> {
	const root = repoDir(machine);
	await eachBatch(machine, 'rm -f', files.filter((file) => file.status === 'D').map((file) => file.path));
	const skipped: string[] = [];
	for (const file of files.filter((item) => item.status !== 'D')) {
		const bytes = file.blob ? await readBlob(file.blob) : null;
		if (!bytes) {
			skipped.push(file.path);
			continue;
		}
		await writeFile(machine, `${root}/${file.path}`, file, bytes);
	}
	return skipped;
}

/** Outputs written straight to storage by tools that run on Anton's side, as the shared browser's screenshots do. */
export async function savedOutputs(id: string): Promise<SavedOutput[]> {
	const bytes = await getProviders().store.get(keys.saved(id));
	return bytes ? (JSON.parse(text(bytes)) as SavedOutput[]) : [];
}

/** One task's saves, one after another, so two at once never lose each other's entry. */
const saving = new Map<string, Promise<unknown>>();

/**
 * Saves an output for the task straight to storage, for the Library, with no
 * machine involved: a task that never started its sandbox has outputs too.
 * Listed alongside the outputs its checkpoints copy from the machine.
 */
export function saveOutput(id: string, path: string, bytes: Uint8Array, contentType?: string): Promise<SavedOutput> {
	const run = async () => {
		const { store } = getProviders();
		const key = keys.output(id, path);
		await store.put(key, bytes, contentType);
		const entry: SavedOutput = { path, size: bytes.length, mtimeMs: Date.now(), key };
		const list = (await savedOutputs(id)).filter((output) => output.path !== path);
		await store.put(keys.saved(id), JSON.stringify([...list, entry]), 'application/json');
		return entry;
	};
	const next = (saving.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
	saving.set(id, next);
	return next;
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

/** `added` and `removed` are null for checkpoints saved before line counts were kept. */
export type CheckpointSummary = { at: string; files: number; added: number | null; removed: number | null; commit: string | null };

/** Checkpoint times are ISO timestamps; anything else is not a key Anton wrote. */
const CHECKPOINT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The task's timeline, newest first: one entry per distinct state of its files. */
export async function listCheckpoints(id: string, limit = 50): Promise<CheckpointSummary[]> {
	const { store } = getProviders();
	const prefix = `sessions/${id}/checkpoints/`;
	const times = (await store.list(prefix))
		.map((object) => object.key.slice(prefix.length))
		.filter((name) => name.endsWith('.json'))
		.map((name) => name.slice(0, -'.json'.length))
		.sort()
		.reverse()
		.slice(0, limit);
	const manifests = await Promise.all(times.map((at) => readCheckpointAt(id, at)));
	return manifests
		.filter((checkpoint): checkpoint is Checkpoint => checkpoint !== null)
		.map((checkpoint) => ({
			at: checkpoint.at,
			files: checkpoint.files.length,
			added: checkpoint.stats?.added ?? null,
			removed: checkpoint.stats?.removed ?? null,
			commit: checkpoint.log[0]?.subject ?? null,
		}));
}

export async function readCheckpointAt(id: string, at: string): Promise<Checkpoint | null> {
	if (!CHECKPOINT_AT.test(at)) return null;
	const bytes = await getProviders().store.get(keys.history(id, at));
	return bytes ? (JSON.parse(text(bytes)) as Checkpoint) : null;
}

/** The diff as it stood at a checkpoint; null for checkpoints saved before diffs were kept. */
export async function readCheckpointPatchAt(id: string, at: string): Promise<string | null> {
	if (!CHECKPOINT_AT.test(at)) return null;
	const bytes = await getProviders().store.get(keys.historyPatch(id, at));
	return bytes ? text(bytes) : null;
}
