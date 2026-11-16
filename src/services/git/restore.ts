import { ConflictError, NotFoundError } from '../../core/errors.ts';
import type { Machine } from '../../core/ports.ts';
import { safeRelativePath } from '../../core/shell.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { isWorking } from '../tasks/activity.ts';
import { applyFiles, eachBatch, readCheckpointAt, saveCheckpoint } from './checkpoints.ts';
import { type FileChange, changes, repoDir } from './git.ts';
import { hasCommit } from './host-commits.ts';
import { machineFor } from '../sandbox/workspace.ts';

export type RestoreResult = { at: string; skipped: string[] };

/** `baseSha` is the base commit or the last push; files added since are removed. */
async function resetToBase(machine: Machine, baseSha: string, files: FileChange[]): Promise<void> {
	const added = files.filter((file) => file.status === 'A').map((file) => file.path);
	const existing = files.filter((file) => file.status !== 'A').map((file) => file.path);
	await eachBatch(machine, 'rm -f', added);
	// Only the working tree, so the agent's index is untouched. The base was checked out at setup, so its files are all here.
	await eachBatch(machine, `git restore --source=${baseSha} --worktree`, existing);
}

const restoring = new Set<string>();

export function isRestoring(id: string): boolean {
	return restoring.has(id);
}

/** Commits stay; only the working tree changes. The state before is checkpointed first, so the restore can be undone. */
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

/** With `to: 'pushed'`, only the unpushed edits go. Checkpointed before and after, so the timeline can undo it. */
export async function revertFile(id: string, rawPath: string, to: 'base' | 'pushed' = 'base'): Promise<void> {
	const path = safeRelativePath(rawPath);
	if (isWorking(id)) throw new ConflictError('Stop the agent before reverting a file');
	if (restoring.has(id)) throw new ConflictError('A restore is already running');
	restoring.add(id);
	try {
		const session = await getSessionRecord(id);
		if (!session) throw new NotFoundError('Task not found');
		const machine = await machineFor(id);
		const since = to === 'pushed' && session.pushedSha && (await hasCommit(machine, session.pushedSha)) ? session.pushedSha : null;
		const file = (await changes(machine, session.baseSha, since)).files.find((change) => change.path === path);
		if (!file) throw new NotFoundError(`${path} has no changes to revert`);
		await saveCheckpoint(id, machine);
		await resetToBase(machine, since ?? session.baseSha, [file]);
		await saveCheckpoint(id, machine);
	} finally {
		restoring.delete(id);
	}
}
