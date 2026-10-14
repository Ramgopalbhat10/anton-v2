import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { Machine } from '../core/ports.ts';
import { quote, run } from '../core/shell.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { repoDir } from './git.ts';
import { bringCommit, OFFLINE_GIT } from './host-commits.ts';
import { machineFor } from './workspace.ts';

/** The base a merge brought in, kept in the machine until the merge is committed. */
const PENDING = '.git/anton-merged-base';

/** Files a merge left in conflict, by path. */
export async function conflictedFiles(machine: Machine): Promise<string[]> {
	const out = await run(machine, 'git diff --name-only --diff-filter=U', { cwd: repoDir(machine), env: OFFLINE_GIT });
	return out.split('\n').filter(Boolean);
}

const list = (paths: string[]) => paths.map((path) => `- ${path}`).join('\n');

/**
 * Merges the latest base branch from the host into the task branch, for a
 * pull request that no longer merges cleanly. The machine has no
 * credentials, so the base's files come through the host's API
 * (`bringCommit`); git then merges as usual and leaves any conflicts in the
 * files for the agent to resolve and commit.
 */
export async function mergeBaseBranch(id: string): Promise<string> {
	const session = await getSessionRecord(id);
	if (!session) throw new NotFoundError('Session not found');
	if (!session.projectId) throw new InvalidInputError('A chat has no base branch to merge.');
	if (session.review) throw new InvalidInputError("This task reviews someone else's pull request, and its branch follows theirs.");
	const project = await getProject(session.projectId);
	if (!project) throw new NotFoundError('Project not found');
	const machine = await machineFor(id);
	const cwd = repoDir(machine);
	if ((await machine.exec('git rev-parse -q --verify MERGE_HEAD', { cwd, env: OFFLINE_GIT })).exitCode === 0) {
		const left = await conflictedFiles(machine);
		throw new InvalidInputError(
			left.length ? `A merge is already under way, with conflicts left in:\n${list(left)}\nResolve them, git add them and commit.` : 'A merge is already under way: commit it with git commit --no-edit.',
		);
	}
	if ((await run(machine, 'git status --porcelain', { cwd, env: OFFLINE_GIT })).trim()) {
		throw new InvalidInputError('Commit your changes first (git add -A && git commit -m "…"), then merge the base branch.');
	}
	const { git } = getProviders();
	const base = session.baseBranch;
	const head = await git.branchHead(project.repoFullName, base);
	if (!head) throw new InvalidInputError(`${base} no longer exists on GitHub.`);
	const short = head.slice(0, 7);
	if ((await machine.exec(`git merge-base --is-ancestor ${head} HEAD`, { cwd, env: OFFLINE_GIT })).exitCode === 0) {
		return `Your branch already has the latest ${base} (${short}).`;
	}
	// The stand-in's parent is where the task branch left the base, so git finds the same merge base the host does.
	const forkPoint = await git.mergeBase(project.repoFullName, head, session.baseSha);
	await bringCommit(machine, project.repoFullName, head, forkPoint, `${base} at ${head}, brought in by Anton from GitHub`);
	await run(machine, `printf %s ${head} > ${PENDING}`, { cwd });
	const merged = await machine.exec(`git -c commit.gpgsign=false merge --no-ff --no-edit -m ${quote(`Merge ${base} into ${session.branch}`)} ${head}`, {
		cwd,
		env: OFFLINE_GIT,
		timeoutMs: 5 * 60_000,
	});
	if (merged.exitCode === 0) {
		await settleMergedBase(id, machine);
		return `Merged the latest ${base} (${short}) with no conflicts. Run the relevant checks, then call open_pull_request to update the pull request.`;
	}
	const conflicted = await conflictedFiles(machine);
	if (!conflicted.length) {
		await run(machine, `rm -f ${PENDING}`, { cwd });
		throw new Error(`git merge failed: ${(merged.stderr || new TextDecoder().decode(merged.stdout)).trim().slice(-1000)}`);
	}
	return [
		`Merged the latest ${base} (${short}); these files have conflicts:`,
		list(conflicted),
		'Resolve each one: read both sides, keep what each meant, and remove the conflict markers. Then git add them, run the relevant checks,',
		'commit the merge with git commit --no-edit, and call open_pull_request to update the pull request.',
	].join('\n');
}

/**
 * Once the task branch contains the base a merge brought in, the task's
 * changes are measured from there, so its diff and reviews leave out what
 * the base already had.
 */
export async function settleMergedBase(id: string, machine: Machine): Promise<void> {
	const cwd = repoDir(machine);
	const pending = await machine.exec(`cat ${PENDING}`, { cwd });
	const sha = new TextDecoder().decode(pending.stdout).trim();
	if (pending.exitCode !== 0 || !sha) return;
	if ((await machine.exec(`git merge-base --is-ancestor ${sha} HEAD`, { cwd, env: OFFLINE_GIT })).exitCode !== 0) return;
	await updateSession(id, { baseSha: sha });
	await run(machine, `rm -f ${PENDING}`, { cwd });
}
