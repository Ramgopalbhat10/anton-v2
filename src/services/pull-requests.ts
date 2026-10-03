import { getProject } from '../db/projects.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { saveCheckpoint } from './checkpoints.ts';
import { reviewAfterPush } from './code-review.ts';
import { commitAndPush } from './git.ts';
import { machineFor } from './workspace.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { PullRequestState } from '../core/ports.ts';

/**
 * Commits the task's work, sends its branch to the host and opens (or finds)
 * the pull request. Anton pushes through the host's API with its own
 * credentials, so they never enter the machine the agent works in. Each push
 * is then reviewed, when reviews are on.
 */
export async function openPullRequest(id: string, input: { title: string; body: string }): Promise<string> {
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	if (!session || !project) throw new NotFoundError('Session not found');
	const { git } = getProviders();
	const machine = await machineFor(id);
	const pushed = await commitAndPush(machine, git, {
		repo: project.repoFullName,
		branch: session.branch,
		baseSha: session.baseSha,
		message: input.title,
	});
	if (!pushed) throw new InvalidInputError('There are no changes to open a pull request with.');
	const url = await git.openPullRequest({
		repo: project.repoFullName,
		head: session.branch,
		base: session.baseBranch,
		title: input.title,
		body: input.body,
	});
	await updateSession(id, { prUrl: url });
	await saveCheckpoint(id, machine);
	reviewAfterPush(id);
	return url;
}

export type PullRequestView = { url: string; state: PullRequestState | null };

/** The task's pull request and its state on the git host, or null before one is opened. */
export async function pullRequestView(id: string): Promise<PullRequestView | null> {
	const session = await getSessionRecord(id);
	if (!session) throw new NotFoundError('Session not found');
	if (!session.prUrl) return null;
	// The link is still worth showing when the host can't be reached.
	const state = await getProviders().git.pullRequestState(session.prUrl).catch(() => null);
	return { url: session.prUrl, state };
}
