import { ConflictError, NotFoundError } from '../core/errors.ts';
import type { Machine } from '../core/ports.ts';
import { safeRelativePath } from '../core/shell.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { isWorking } from './activity.ts';
import { applyFiles, eachBatch, readCheckpointAt, saveCheckpoint } from './checkpoints.ts';
import { type FileChange, changes, repoDir } from './git.ts';
import { machineFor } from './workspace.ts';

export type RestoreResult = { at: string; skipped: string[] };

/** Puts changed files back as they are at the base commit; files the task added are removed. */
async function resetToBase(machine: Machine, baseSha: string, files: FileChange[]): Promise<void> {
	const added = files.filter((file) => file.status === 'A').map((file) => file.path);
	const existing = files.filter((file) => file.status !== 'A').map((file) => file.path);
	await eachBatch(machine, 'rm -f', added);
	// Only the working tree, so the agent's index is untouched. The base was checked out at setup, so its files are all here.
	await eachBatch(machine, `git restore --source=${baseSha} --worktree`, existing);
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

/**
 * Puts one changed file back as it is at the base commit, removing it if the
 * task added it. Checkpointed before and after, so the timeline can undo it.
 */
export async function revertFile(id: string, rawPath: string): Promise<void> {
	const path = safeRelativePath(rawPath);
	if (isWorking(id)) throw new ConflictError('Stop the agent before reverting a file');
	if (restoring.has(id)) throw new ConflictError('A restore is already running');
	restoring.add(id);
	try {
		const session = await getSessionRecord(id);
		if (!session) throw new NotFoundError('Task not found');
		const machine = await machineFor(id);
		const file = (await changes(machine, session.baseSha)).files.find((change) => change.path === path);
		if (!file) throw new NotFoundError(`${path} has no changes to revert`);
		await saveCheckpoint(id, machine);
		await resetToBase(machine, session.baseSha, [file]);
		await saveCheckpoint(id, machine);
	} finally {
		restoring.delete(id);
	}
}
