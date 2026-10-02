import { ConflictError, NotFoundError } from '../core/errors.ts';
import { writeMachineFile } from '../core/machine-fs.ts';
import type { Machine } from '../core/ports.ts';
import { quote, run } from '../core/shell.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { isWorking } from './activity.ts';
import { type SavedFile, readBlob, readCheckpointAt, saveCheckpoint } from './checkpoints.ts';
import { type FileChange, changes, repoDir } from './git.ts';
import { machineFor } from './workspace.ts';

export type RestoreResult = { at: string; skipped: string[] };

/** Runs `command` over the paths in batches, so a long list never overflows the command line. */
async function eachBatch(machine: Machine, command: string, paths: string[], env?: Record<string, string>): Promise<void> {
	for (let start = 0; start < paths.length; start += 200) {
		const batch = paths.slice(start, start + 200).map(quote).join(' ');
		await run(machine, `${command} -- ${batch}`, { cwd: repoDir(machine), env });
	}
}

/** Puts changed files back as they are at the base commit; files the task added are removed. */
async function resetToBase(machine: Machine, baseSha: string, files: FileChange[]): Promise<void> {
	const added = files.filter((file) => file.status === 'A').map((file) => file.path);
	const existing = files.filter((file) => file.status !== 'A').map((file) => file.path);
	await eachBatch(machine, 'rm -f', added);
	// A partial clone may fetch base blobs on demand, which needs Anton's credentials.
	await eachBatch(machine, `git checkout ${baseSha}`, existing, getProviders().git.gitAuthEnv());
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
		const path = `${root}/${file.path}`;
		await run(machine, `mkdir -p ${quote(path.slice(0, path.lastIndexOf('/')))}`);
		await writeMachineFile(machine, path, bytes);
	}
	return skipped;
}

/**
 * Puts the task's files back as they were at a checkpoint. Commits stay; only
 * the working tree changes. The state before the restore is checkpointed
 * first, so the restore itself can be undone from the timeline.
 */
export async function restoreCheckpoint(id: string, at: string): Promise<RestoreResult> {
	if (isWorking(id)) throw new ConflictError('Stop the agent before restoring a checkpoint');
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
}
