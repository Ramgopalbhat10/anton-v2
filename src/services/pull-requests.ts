import { getProject } from '../db/projects.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { saveCheckpoint } from './checkpoints.ts';
import { commitAndPush } from './git.ts';
import { machineFor } from './workspace.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';

/**
 * Commits the task's work, pushes its branch and opens (or finds) the pull
 * request. Anton holds the git credentials; the agent never sees them.
 */
export async function openPullRequest(id: string, input: { title: string; body: string }): Promise<string> {
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	if (!session || !project) throw new NotFoundError('Session not found');
	const { git } = getProviders();
	const machine = await machineFor(id);
	const pushed = await commitAndPush(machine, {
		branch: session.branch,
		baseSha: session.baseSha,
		message: input.title,
		auth: git.gitAuthEnv(),
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
	return url;
}
