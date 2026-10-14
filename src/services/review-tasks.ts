import { InvalidInputError } from '../core/errors.ts';
import type { Session } from '../core/types.ts';
import { listProjects, reviewedRepos } from '../db/projects.ts';
import { listSessionRecords } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { isWorking } from './activity.ts';
import { budget } from './budget.ts';
import { requestReview } from './code-review.ts';
import { generalSettings } from './general.ts';
import { logProblem } from './log.ts';
import { addProject } from './projects.ts';
import { createSession, getSession } from './sessions.ts';

const PULL_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** At most this many new reviews start in one repo each round, so turning reviews on for a busy repo eases in. */
const NEW_AT_ONCE = 2;

/** A pull request link as GitHub writes it, without a tab (`/files`), query or anchor. */
export function pullRequestUrl(input: string): string {
	const match = PULL_URL.exec(input.trim());
	if (!match) throw new InvalidInputError('Paste a GitHub pull request link, such as https://github.com/owner/repo/pull/12');
	return `https://github.com/${match[1]}/pull/${match[2]}`;
}

/**
 * Reviews any pull request, by its link: Anton's own from the task that
 * opened it, anyone else's in a task of its own, created the first time
 * (adding the repository if it is new) on the merge base, which the
 * pull request's head is then put on top of. The review runs in the task's
 * sandbox and is posted on GitHub, and the task stays open to ask about it.
 */
export async function reviewPullRequest(link: string, { automatic = false }: { automatic?: boolean } = {}): Promise<Session> {
	const url = pullRequestUrl(link);
	const existing = (await listSessionRecords()).find((session) => session.prUrl === url);
	if (existing) {
		if (!(await requestReview(existing.id, { automatic })) && !automatic) throw new InvalidInputError('The review did not start.');
		return getSession(existing.id);
	}
	const { git } = getProviders();
	const info = await git.pullRequest(url);
	if (info.state === 'merged' || info.state === 'closed') throw new InvalidInputError(`That pull request is ${info.state}.`);
	const project = (await listProjects()).find((repo) => repo.repoFullName.toLowerCase() === info.repo.toLowerCase()) ?? (await addProject(info.repo));
	const base = await git.mergeBase(info.repo, info.baseBranch, info.headSha);
	const reviewer = (await generalSettings()).agentModels.reviewer;
	const session = await createSession({
		projectId: project.id,
		branch: info.baseBranch,
		baseSha: base,
		title: `Review #${info.number} ${info.title}`.slice(0, 200),
		...(reviewer ? { model: reviewer.model, reasoning: reviewer.reasoning ?? undefined } : {}),
		planMode: false,
		prUrl: url,
		review: { number: info.number, author: info.author, trusted: info.trusted, reviewedHead: null, automatic },
	});
	await requestReview(session.id, { automatic: false });
	return getSession(session.id);
}

/**
 * For each repo with Review every pull request on: a review of each open
 * pull request updated since it was turned on, and again when its author
 * pushes. Drafts, Anton's own pull requests (its Reviewer reads those) and
 * pull requests from people who cannot push to the repo are left alone.
 */
export async function runAutomaticReviews(): Promise<void> {
	if ((await budget()).blocked) return;
	const tasks = new Map((await listSessionRecords()).flatMap((session) => (session.prUrl ? [[session.prUrl, session] as const] : [])));
	for (const { project, since } of await reviewedRepos()) {
		const pulls = await getProviders()
			.git.listPullRequests(project.repoFullName)
			.catch((error: unknown) => {
				logProblem('warn', 'Could not list pull requests to review', error);
				return [];
			});
		let started = 0;
		for (const pull of pulls) {
			if (pull.draft || !pull.trusted || pull.updatedAt < since || pull.headBranch.startsWith('anton/')) continue;
			const task = tasks.get(pull.url);
			if (task && !task.review) continue;
			if (task) {
				if (task.review?.reviewedHead !== pull.headSha && !isWorking(task.id)) {
					await requestReview(task.id, { automatic: true }).catch((error: unknown) => logProblem('warn', 'Could not start the pull request review', error, task.id));
				}
				continue;
			}
			if (started >= NEW_AT_ONCE) continue;
			started += 1;
			await reviewPullRequest(pull.url, { automatic: true }).catch((error: unknown) => logProblem('warn', `Could not review ${pull.url}`, error));
		}
	}
}
