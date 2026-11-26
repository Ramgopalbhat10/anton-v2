import { createHash } from 'node:crypto';
import { listMachineFiles, readMachineFile, writeMachineFile } from '../../core/machine-fs.ts';
import type { Machine, ObjectStore } from '../../core/ports.ts';
import { quote, run, text } from '../../core/shell.ts';
import { getSessionRecord, updateSession } from '../../db/sessions.ts';
import { forgetOutputIndex } from '../../db/pages.ts';
import { getProviders } from '../../providers/index.ts';
import { type FileChange, type LogEntry, changes, repoDir } from './git.ts';
import { hasCommit } from './host-commits.ts';
import { downloadInto } from '../sandbox/machine-download.ts';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

export type SavedFile = FileChange & { blob: string | null };
export type SavedOutput = { path: string; size: number; mtimeMs: number; key: string | null };

export type Checkpoint = {
	at: string;
	baseSha: string;
	branch: string;
	files: SavedFile[];
	log: LogEntry[];
	outputs: SavedOutput[];
	stats?: { added: number; removed: number };
	/** What changed since `pushedSha`, the commit last pushed; null means nothing was pushed. Absent on older checkpoints. */
	unpushed?: { pushedSha: string | null; files: FileChange[]; stats: { added: number; removed: number } };
};

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
	unpushedPatch: (id: string) => `sessions/${id}/checkpoint-unpushed.patch`,
	output: (id: string, path: string) => `sessions/${id}/outputs/${path}`,
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

export async function readUnpushedPatch(id: string, checkpoint: Checkpoint): Promise<string> {
	if (!checkpoint.unpushed?.pushedSha) return readCheckpointPatch(id);
	const bytes = await getProviders().store.get(keys.unpushedPatch(id));
	return bytes ? text(bytes) : '';
}

const stateOf = (checkpoint: Checkpoint) => JSON.stringify([checkpoint.files, checkpoint.log.map((entry) => entry.sha)]);

function sameSave(previous: Checkpoint, next: Checkpoint): boolean {
	const rest = (checkpoint: Checkpoint) => JSON.stringify([checkpoint.baseSha, checkpoint.branch, checkpoint.outputs, checkpoint.log, checkpoint.stats ?? null, checkpoint.unpushed ?? null]);
	return stateOf(previous) === stateOf(next) && rest(previous) === rest(next);
}

let writing = 0;
let sweep: Promise<unknown> | null = null;

/** A checkpoint reuses blobs it finds already stored, so a sweep running alongside could remove one it is about to point at. */
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

export function saveCheckpoint(id: string, machine: Machine): Promise<Checkpoint> {
	return asWrite(() => writeCheckpoint(id, machine));
}

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
	const pushedSha = session.pushedSha && (await hasCommit(machine, session.pushedSha)) ? session.pushedSha : null;
	const [whole, since] = await Promise.all([changes(machine, session.baseSha), pushedSha ? changes(machine, session.baseSha, pushedSha) : null]);
	const checkpoint: Checkpoint = {
		at: new Date().toISOString(),
		baseSha: session.baseSha,
		branch: session.branch,
		files: await Promise.all(whole.files.map((change) => saveFile(store, machine, change))),
		log: (since ?? whole).log,
		outputs: await syncOutputs(id, store, machine, previous?.outputs ?? []),
		stats: statsOf(whole.patch),
		unpushed: since
			? { pushedSha, files: since.files.map(({ path, status }) => ({ path, status })), stats: statsOf(since.patch) }
			: { pushedSha: null, files: whole.files.map(({ path, status }) => ({ path, status })), stats: statsOf(whole.patch) },
	};
	// Every upload is a billed request, so a save that would store the same thing again stores nothing.
	if (previous && sameSave(previous, checkpoint)) {
		await updateSession(id, { checkpointAt: checkpoint.at });
		return previous;
	}
	const manifest = JSON.stringify(checkpoint);
	await store.put(keys.patch(id), whole.patch, 'text/x-diff');
	if (since) await store.put(keys.unpushedPatch(id), since.patch, 'text/x-diff');
	// The timeline keeps one entry per distinct state, not one per response.
	if (!previous || stateOf(previous) !== stateOf(checkpoint)) {
		await store.put(keys.historyPatch(id, checkpoint.at), whole.patch, 'text/x-diff');
		await store.put(keys.history(id, checkpoint.at), manifest, 'application/json');
	}
	await store.put(keys.latest(id), manifest, 'application/json');
	await updateSession(id, { checkpointAt: checkpoint.at });
	await forgetOutputIndex(id);
	return checkpoint;
}

/** Blobs are shared, so only the manifest and the diff are copied; outputs stay with the original. */
export function copyCheckpoint(from: string, to: string): Promise<Checkpoint | null> {
	return asWrite(() => writeCopy(from, to));
}

async function writeCopy(from: string, to: string): Promise<Checkpoint | null> {
	const [source, target] = await Promise.all([readCheckpoint(from), getSessionRecord(to)]);
	if (!source || !target) return null;
	const { store } = getProviders();
	const patch = await readCheckpointPatch(from);
	// The fork has pushed nothing, so all its files are unpushed work.
	const unpushed = { pushedSha: null, files: source.files.map(({ path, status }) => ({ path, status })), stats: source.stats ?? statsOf(patch) };
	const copy: Checkpoint = { ...source, at: new Date().toISOString(), branch: target.branch, log: [], outputs: [], unpushed };
	const manifest = JSON.stringify(copy);
	await store.put(keys.patch(to), patch, 'text/x-diff');
	await store.put(keys.historyPatch(to, copy.at), patch, 'text/x-diff');
	await store.put(keys.history(to, copy.at), manifest, 'application/json');
	await store.put(keys.latest(to), manifest, 'application/json');
	await updateSession(to, { checkpointAt: copy.at });
	return copy;
}

export async function eachBatch(machine: Machine, command: string, paths: string[]): Promise<void> {
	for (let start = 0; start < paths.length; start += 200) {
		const batch = paths.slice(start, start + 200).map(quote).join(' ');
		await run(machine, `${command} -- ${batch}`, { cwd: repoDir(machine) });
	}
}

/** Whatever is at the path goes first, so a write never follows a symlink out of place. */
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

/** Written by tools that run on Anton's side, as the shared browser's screenshots do. */
export async function savedOutputs(id: string): Promise<SavedOutput[]> {
	const bytes = await getProviders().store.get(keys.saved(id));
	return bytes ? (JSON.parse(text(bytes)) as SavedOutput[]) : [];
}

/** A fresh machine has neither your uploads nor what the agent saved, and the next checkpoint lists only what the machine holds, so without this the Library would empty. */
export async function copyLibrary(machine: Machine, id: string): Promise<void> {
	const [saved, checkpoint] = await Promise.all([savedOutputs(id), readCheckpoint(id)]);
	const wanted = new Map<string, SavedOutput & { key: string }>();
	for (const output of [...(checkpoint?.outputs ?? []), ...saved.filter((output) => output.path.startsWith('uploads/'))]) {
		if (output.key) wanted.set(output.path, { ...output, key: output.key });
	}
	if (!wanted.size) return;
	const present = new Set((await listMachineFiles(machine, `${machine.root}/outputs`)).map((file) => file.path));
	const missing = [...wanted.values()].filter((output) => !present.has(output.path));
	await downloadInto(
		machine,
		missing.map((output) => ({ key: output.key, target: `${machine.root}/outputs/${output.path}`, size: output.size })),
	);
}

/** So two saves at once never lose each other's entry. */
const saving = new Map<string, Promise<unknown>>();

/** No machine involved: a task that never started its sandbox has outputs too. */
export function saveOutput(id: string, path: string, bytes: Uint8Array, contentType?: string): Promise<SavedOutput> {
	const run = async () => {
		const { store } = getProviders();
		const key = keys.output(id, path);
		await store.put(key, bytes, contentType);
		const entry: SavedOutput = { path, size: bytes.length, mtimeMs: Date.now(), key };
		const list = (await savedOutputs(id)).filter((output) => output.path !== path);
		await store.put(keys.saved(id), JSON.stringify([...list, entry]), 'application/json');
		await forgetOutputIndex(id);
		return entry;
	};
	const next = (saving.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
	saving.set(id, next);
	return next;
}

/** The machine's own file is the caller's to remove, or the next checkpoint lists it again. */
export function deleteOutput(id: string, path: string): Promise<void> {
	const run = async () => {
		const { store } = getProviders();
		await store.remove(keys.output(id, path));
		const saved = await savedOutputs(id);
		if (saved.some((output) => output.path === path)) {
			await store.put(keys.saved(id), JSON.stringify(saved.filter((output) => output.path !== path)), 'application/json');
		}
		const latest = await readCheckpoint(id);
		if (latest?.outputs.some((output) => output.path === path)) {
			const next = { ...latest, outputs: latest.outputs.filter((output) => output.path !== path) };
			await store.put(keys.latest(id), JSON.stringify(next), 'application/json');
		}
		await forgetOutputIndex(id);
	};
	const next = (saving.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
	saving.set(id, next);
	return next;
}

export async function readOutput(id: string, path: string): Promise<Uint8Array | null> {
	return getProviders().store.get(keys.output(id, path));
}

/** A file of `../outputs` as a fresh machine would get it from `copyLibrary`, read without one. */
export async function readLibraryFile(id: string, path: string): Promise<Uint8Array | null> {
	const [saved, checkpoint] = await Promise.all([savedOutputs(id), readCheckpoint(id)]);
	const found = saved.find((output) => output.path === path) ?? checkpoint?.outputs.find((output) => output.path === path);
	return found?.key ? readBlob(found.key) : null;
}

export async function readBlob(key: string): Promise<Uint8Array | null> {
	return getProviders().store.get(key);
}

/** Blobs are shared between tasks, so they stay. */
export async function deleteCheckpoints(id: string): Promise<void> {
	const { store } = getProviders();
	const objects = await store.list(`sessions/${id}/`);
	await Promise.all(objects.map((object) => store.remove(object.key)));
}

export type CheckpointSummary = { at: string; files: number; added: number | null; removed: number | null; commit: string | null };

const CHECKPOINT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

export async function readCheckpointPatchAt(id: string, at: string): Promise<string | null> {
	if (!CHECKPOINT_AT.test(at)) return null;
	const bytes = await getProviders().store.get(keys.historyPatch(id, at));
	return bytes ? text(bytes) : null;
}
