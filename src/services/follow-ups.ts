import type { CheckResult, PullRequestActivity, PullRequestComment } from '../core/ports.ts';
import type { SessionRecord } from '../core/types.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord, listSessionRecords, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { isWorking } from './activity.ts';
import { sendToAgent } from './agent-runner.ts';
import { budget } from './budget.ts';
import { CLEAN_MARK } from './code-review.ts';
import { logProblem } from './log.ts';

/** After this many automatic messages a task waits for a person, so a fix that keeps failing cannot loop. */
export const MAX_FOLLOW_UPS = 5;

/**
 * What has been handled on one pull request: the last head commit whose
 * failures were sent, the comments sent, how many messages since a person
 * last wrote, and whether it is merged or closed.
 */
type FollowState = { url?: string; sha: string | null; seen: string[]; sent: number; done?: boolean };

const initial: FollowState = { sha: null, seen: [], sent: 0 };

/** The state for the task's current pull request; a new pull request starts afresh. */
function stateFor(session: SessionRecord): FollowState {
	const state = session.followState ? (JSON.parse(session.followState) as FollowState) : initial;
	return state.url === undefined || state.url === session.prUrl ? state : initial;
}

/**
 * Deploy and status bots comment on every push; review bots leave reviews and
 * line comments, which are kept. Anton's own review that found nothing asks nothing.
 */
const isNoise = (comment: PullRequestComment) => (comment.author.endsWith('[bot]') && comment.id.startsWith('comment-')) || comment.body.includes(CLEAN_MARK);

function checksMessage(url: string, sha: string, failed: CheckResult[]): string {
	return [
		`Checks failed on your pull request (${url}) at ${sha.slice(0, 7)}:`,
		...failed.map((check) => `- ${check.name}: ${check.summary || 'failed'} (${check.url})`),
		'Find the cause, fix it, run the relevant checks in the sandbox, then call open_pull_request to update the pull request.',
	].join('\n');
}

function commentsMessage(url: string, comments: PullRequestComment[]): string {
	return [
		`New comments on your pull request (${url}):`,
		...comments.map((comment, index) => {
			const where = comment.path ? ` on ${comment.path}${comment.line ? ` line ${comment.line}` : ''}` : '';
			return `${index + 1}. @${comment.author}${where}: ${comment.body.replace(/\n/g, '\n   ')}`;
		}),
		'Address each one, then call open_pull_request to update the pull request. If you disagree with one, say why in your reply.',
	].join('\n');
}

/** What to tell the agent about the pull request now, and the state that records it as handled. */
export function nextFollowUp(url: string, activity: PullRequestActivity, state: FollowState): { message: string | null; state: FollowState } {
	const settled = !activity.checks.some((check) => check.status === 'pending');
	const failed = activity.checks.filter((check) => check.status === 'failed');
	const reportChecks = settled && failed.length > 0 && state.sha !== activity.headSha;
	const fresh = activity.comments.filter((comment) => !state.seen.includes(comment.id) && !isNoise(comment));
	const parts = [...(reportChecks ? [checksMessage(url, activity.headSha, failed)] : []), ...(fresh.length ? [commentsMessage(url, fresh)] : [])];
	if (parts.length === 0) return { message: null, state };
	return {
		message: parts.join('\n\n'),
		state: {
			sha: reportChecks ? activity.headSha : state.sha,
			seen: [...state.seen, ...fresh.map((comment) => comment.id)].slice(-500),
			sent: state.sent + 1,
		},
	};
}

/** Sends the agent anything new on its pull request: failed checks on the latest commit, and new comments. */
export async function followUp(session: SessionRecord): Promise<boolean> {
	if (!session.prUrl || isWorking(session.id)) return false;
	const project = await getProject(session.projectId);
	const state = stateFor(session);
	if (!project?.followUps || state.done || state.sent >= MAX_FOLLOW_UPS) return false;
	const activity = await getProviders().git.pullRequestActivity(session.prUrl);
	const save = (next: FollowState) => updateSession(session.id, { followState: JSON.stringify({ ...next, url: session.prUrl }) });
	if (activity.state === 'merged' || activity.state === 'closed') {
		// Never looked at again, so finished tasks cost no requests on every poll.
		await save({ ...state, done: true });
		return false;
	}
	const next = nextFollowUp(session.prUrl, activity, state);
	if (!next.message) return false;
	await sendToAgent(session.id, next.message);
	await save(next.state);
	return true;
}

/** A person wrote to the task, so its agent may again follow up on its own up to the limit. */
export async function resetFollowUps(id: string): Promise<void> {
	const session = await getSessionRecord(id);
	if (!session?.followState) return;
	const state = stateFor(session);
	if (state.sent > 0) await updateSession(id, { followState: JSON.stringify({ ...state, sent: 0 }) });
}

/** Checks every task with a pull request; one failing never stops the rest. */
export async function runFollowUps(): Promise<void> {
	if ((await budget()).blocked) return;
	for (const session of (await listSessionRecords()).filter((record) => record.prUrl)) {
		await followUp(session).catch((error: unknown) => logProblem('warn', 'Pull request follow-up failed', error, session.id));
	}
}
