import { announce } from '../core/changes.ts';
import type { CheckResult, PullRequestActivity } from '../core/ports.ts';
import type { PullRequestStatus, SessionRecord } from '../core/types.ts';
import { setPullRequestState } from '../db/pull-requests.ts';
import { listSessionRecords, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { logProblem } from './log.ts';
import { threadChanged } from './thread-reports.ts';

/** A pull request read this recently is not read again by the background refresh. */
const FRESH_MS = 4 * 60_000;
const readAt = new Map<string, number>();
const heads = new Map<string, string>();

/** Checks on the head commit in a word: failed if any failed, pending while any run, passed otherwise. */
function checksOf(checks: CheckResult[]): PullRequestStatus['checks'] {
	if (checks.some((check) => check.status === 'failed')) return 'failed';
	if (checks.some((check) => check.status === 'pending')) return 'pending';
	return checks.some((check) => check.status === 'passed') ? 'passed' : null;
}

/** Keeps a task's pull request status, writing (and so announcing) only a change. */
export async function savePullRequestStatus(session: SessionRecord, status: PullRequestStatus): Promise<void> {
	if (!session.prUrl) return;
	if (JSON.stringify(session.pullRequest) === JSON.stringify(status)) return;
	await updateSession(session.id, { pullRequestJson: JSON.stringify({ url: session.prUrl, ...status }) });
	if (status.state !== session.pullRequest?.state) await setPullRequestState(session.prUrl, status.state);
	// A task is done once its pull request merges or closes; a project's thread also tells its coordinator.
	await threadChanged(session.id).catch((error: unknown) => logProblem('warn', 'Could not report the thread', error, session.id));
}

/** Reads a task's pull request from the host and keeps its state and checks for the sidebar. */
export async function readPullRequest(session: SessionRecord & { prUrl: string }): Promise<PullRequestActivity> {
	const activity = await getProviders().git.pullRequestActivity(session.prUrl);
	readAt.set(session.id, Date.now());
	const revision = JSON.stringify([session.prUrl, activity.headSha, activity.baseSha, activity.headBranch, activity.baseBranch, activity.state]);
	if (heads.get(session.id) !== revision) {
		heads.set(session.id, revision);
		announce({ kind: 'task', id: session.id, what: 'pr-metadata' });
	}
	// A pull request opened before Anton kept what it pushed: its head is what the host has, so Changes can leave it out.
	if (!session.pushedSha && !session.review && activity.headSha) await updateSession(session.id, { pushedSha: activity.headSha });
	const open = activity.state === 'open' || activity.state === 'draft';
	const runs = activity.checks.flatMap(({ name, status, url }) => (status === 'skipped' ? [] : [{ name, status, url }]));
	await savePullRequestStatus(session, {
		state: activity.state,
		checks: open ? checksOf(activity.checks) : null,
		...(open && activity.approved ? { approved: true } : {}),
		...(open && activity.conflicts ? { conflicts: true } : {}),
		runs: open ? runs : [],
	});
	return activity;
}

/** Merged and closed pull requests never change. */
export const finished = (session: SessionRecord) => session.pullRequest?.state === 'merged' || session.pullRequest?.state === 'closed';

/** Reads every open pull request not read lately; merged and closed ones never change, so they are left alone. */
export async function refreshPullRequests(now = Date.now()): Promise<void> {
	const due = (await listSessionRecords()).filter((session) => session.prUrl && !finished(session) && now - (readAt.get(session.id) ?? 0) > FRESH_MS);
	for (const session of due) {
		await readPullRequest(session as SessionRecord & { prUrl: string }).catch((error: unknown) =>
			logProblem('warn', 'Could not read the pull request', error, session.id),
		);
	}
}
