import { ConflictError, NotFoundError } from '../core/errors.ts';
import { writeMachineFile } from '../core/machine-fs.ts';
import type { Machine } from '../core/ports.ts';
import { quote, run } from '../core/shell.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { isWorking } from './activity.ts';
import { SYMLINK_MODE, type SavedFile, readBlob, readCheckpointAt, saveCheckpoint } from './checkpoints.ts';
import { type FileChange, changes, repoDir } from './git.ts';
import { machineFor } from './workspace.ts';

export type RestoreResult = { at: string; skipped: string[] };

/** Runs `command` over the paths in batches, so a long list never overflows the command line. */
async function eachBatch(machine: Machine, command: string, paths: string[]): Promise<void> {
	for (let start = 0; start < paths.length; start += 200) {
		const batch = paths.slice(start, start + 200).map(quote).join(' ');
		await run(machine, `${command} -- ${batch}`, { cwd: repoDir(machine) });
	}
}

/** Puts changed files back as they are at the base commit; files the task added are removed. */
async function resetToBase(machine: Machine, baseSha: string, files: FileChange[]): Promise<void> {
	const added = files.filter((file) => file.status === 'A').map((file) => file.path);
	const existing = files.filter((file) => file.status !== 'A').map((file) => file.path);
	await eachBatch(machine, 'rm -f', added);
	// Only the working tree, so the agent's index is untouched. The base was checked out at setup, so its files are all here.
	await eachBatch(machine, `git restore --source=${baseSha} --worktree`, existing);
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
async function applyFiles(machine: Machine, files: SavedFile[]): Promise<string[]> {
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

/** Tasks whose files are being restored; their agent takes no new messages until it finishes. */
const restoring = new Set<string>();

export function isRestoring(id: string): boolean {
	return restoring.has(id);
}

/**
 * Puts the task's files back as they were at a checkpoint. Commits stay; only
 * the working tree changes. The state before the restore is checkpointed
 * first, so the restore itself can be undone from the timeline.
 */
export async function restoreCheckpoint(id: string, at: string): Promise<RestoreResult> {
	if (isWorking(id)) throw new ConflictError('Stop the agent before restoring a checkpoint');
	if (restoring.has(id)) throw new ConflictError('A restore is already running');
	restoring.add(id);
	try {
		const session = await getSessionRecord(id);
		const target = session && (await readCheckpointAt(id, at));
		if (!session || !target) throw new NotFoundError('Checkpoint not found');
		const machine = await machineFor(id);
		await saveCheckpoint(id, machine);
		const keep = new Set(target.files.map((file) => file.path));
		const current = (await changes(machine, session.baseSha)).files;
		await resetToBase(machine, session.baseSha, current.filter((file) => !keep.has(file.path)));
		const skipped = await applyFiles(machine, target.files);
		await saveCheckpoint(id, machine);
		return { at, skipped };
	} finally {
		restoring.delete(id);
	}
}
