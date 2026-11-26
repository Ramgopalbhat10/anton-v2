import type { CheckResult, PullRequestActivity, PullRequestComment } from '../../core/ports.ts';
import type { SessionRecord } from '../../core/types.ts';
import { getProject } from '../../db/projects.ts';
import { getSessionRecord, listSessionRecords, updateSession } from '../../db/sessions.ts';
import { isWorking } from '../tasks/activity.ts';
import { sendToAgent } from '../tasks/agent-runner.ts';
import { budget } from '../models/budget.ts';
import { CLEAN_MARK, isMinorFinding, REVIEW_MARK } from './code-review.ts';
import { generalSettings } from '../models/general.ts';
import { decide, yesOf } from '../models/decisions.ts';
import { logProblem } from '../../core/log.ts';
import { readPullRequest } from './pr-status.ts';
import { ANSWER_MARK, guidance, PR_COMMENTS_HEAD } from '../../core/review-follow-up.ts';

/** So a fix that keeps failing cannot loop. */
export const MAX_FOLLOW_UPS = 5;

type FollowState = { url?: string; sha: string | null; conflict?: string | null; seen: string[]; sent: number; done?: boolean };

const initial: FollowState = { sha: null, seen: [], sent: 0 };

function stateFor(session: SessionRecord): FollowState {
	const state = session.followState ? (JSON.parse(session.followState) as FollowState) : initial;
	return state.url === undefined || state.url === session.prUrl ? state : initial;
}

/** Deploy and status bots comment on every push; review bots' reviews and line comments are kept. */
const isNoise = (comment: PullRequestComment) => (comment.author.endsWith('[bot]') && comment.id.startsWith('comment-')) || comment.body.includes(CLEAN_MARK);

export const unseenComments = (activity: PullRequestActivity, state: FollowState) => activity.comments.filter((comment) => !state.seen.includes(comment.id) && !isNoise(comment));

/** At or below this chance a comment is taken as thanks or approval and never wakes the agent. */
const ASKS_NOTHING = 0.1;

async function askingNothing(id: string, comments: PullRequestComment[]): Promise<string[]> {
	const asks = { type: 'yes-no', instructions: 'Does this pull request comment ask the author to change something, answer a question, or do anything else?' } as const;
	const answers = await Promise.all(comments.map((comment) => decide(id, { comment: comment.body.slice(0, 20_000) }, { asks })));
	return comments.filter((_, index) => (yesOf(answers[index]?.asks) ?? 1) <= ASKS_NOTHING).map((comment) => comment.id);
}

function checksMessage(url: string, sha: string, failed: CheckResult[]): string {
	return [
		`Checks failed on your pull request (${url}) at ${sha.slice(0, 7)}:`,
		...failed.map((check) => `- ${check.name}: ${check.summary || 'failed'} (${check.url})`),
		guidance('Find the cause, fix it, run the relevant checks in the sandbox, then call open_pull_request to update the pull request.'),
	].join('\n');
}

function conflictsMessage(url: string, base: string): string {
	return [
		`Your pull request (${url}) has merge conflicts with ${base}, so it cannot be merged.`,
		guidance(`Call merge_base_branch to merge the latest ${base} into your branch, resolve the conflicts it leaves, run the relevant checks, commit the merge, then call open_pull_request to update the pull request.`),
	].join('\n');
}

/*
 * A fix aimed only at the reported line tends to move the problem: over five production pull requests (Nov 2026), 7 of 19
 * review findings were caused or left half-fixed by the previous round's fix, each a full round of the agent's context.
 */
function commentsMessage(url: string, comments: PullRequestComment[]): string {
	return [
		`${PR_COMMENTS_HEAD} (${url}):`,
		...comments.map((comment, index) => {
			const where = comment.path ? ` on ${comment.path}${comment.line ? ` line ${comment.line}` : ''}` : '';
			return `${index + 1}. [${comment.id}] @${comment.author}${where}: ${comment.body.replace(/\n/g, '\n   ')}`;
		}),
		guidance(
			[
				'For each one, first check it against the code and what the user asked for: a reviewer can be wrong, and one that is wrong, or rests on a risk the code already accepts elsewhere, gets a one-line reason in your reply instead of a fix. ' +
					'For the rest: find the cause, not only the line named, and fix it wherever the same mistake appears in your change. ' +
					'Then ask what your fix could break (state it leaves behind, ordering and timing, error paths, what moved on screen) and check that too. ' +
					'Cover each fix with a test that runs the real code path with data shaped as the system produces it, not a stand-in that skips it. ' +
					'Do not build a new feature, data model, approval flow, or authorization check or guard to answer a comment, whatever its severity: answer it as a question for the user.',
				'Then call open_pull_request to update the pull request, and answer each comment with answer_review_comment by its id in brackets: fixed, declined with why it does not hold, or question for the user. ' +
					'Anton posts your answers on the pull request, resolves the fixed and declined threads, and the next review reads them. read_review_comments shows earlier threads and their answers. ' +
					'If one is a question for the user, end your reply by asking it with the ask tool, with options to pick from.',
			].join('\n'),
		),
	].join('\n');
}

/**
 * Comments that never wake the agent: Anton's review summary, whose findings arrive as its line comments, the agent's own
 * answers (`answer_review_comment`), and, unless the
 * user chose otherwise, its low-severity findings, which stay on the pull request for a person to weigh. A fix round
 * resumes the agent's whole conversation, about ten times a review's tokens.
 */
export const heldBack = (comments: PullRequestComment[], fixLow: boolean): string[] =>
	comments
		.filter((comment) => comment.body.includes(REVIEW_MARK) || comment.body.includes(ANSWER_MARK) || (!fixLow && isMinorFinding(comment.body)))
		.map((comment) => comment.id);

/** `quiet` comments are marked seen without a message. Conflicts are sent once for each head and base. */
export function nextFollowUp(
	url: string,
	activity: PullRequestActivity,
	state: FollowState,
	quiet: string[] = [],
	base = 'the base branch',
): { message: string | null; state: FollowState } {
	const settled = !activity.checks.some((check) => check.status === 'pending');
	const failed = activity.checks.filter((check) => check.status === 'failed');
	const reportChecks = settled && failed.length > 0 && state.sha !== activity.headSha;
	const conflict = activity.conflicts ? `${activity.headSha} ${activity.baseSha ?? ''}` : null;
	const reportConflict = conflict !== null && state.conflict !== conflict;
	const unseen = unseenComments(activity, state);
	const fresh = unseen.filter((comment) => !quiet.includes(comment.id));
	const parts = [
		...(reportConflict ? [conflictsMessage(url, base)] : []),
		...(reportChecks ? [checksMessage(url, activity.headSha, failed)] : []),
		...(fresh.length ? [commentsMessage(url, fresh)] : []),
	];
	if (parts.length === 0 && fresh.length === unseen.length) return { message: null, state };
	return {
		message: parts.length ? parts.join('\n\n') : null,
		state: {
			sha: reportChecks ? activity.headSha : state.sha,
			conflict: reportConflict ? conflict : (state.conflict ?? null),
			seen: [...state.seen, ...unseen.map((comment) => comment.id)].slice(-500),
			sent: state.sent + (parts.length ? 1 : 0),
		},
	};
}

export async function followUp(session: SessionRecord, read?: PullRequestActivity): Promise<boolean> {
	// A task reviewing someone else's pull request has nothing to fix there; its reviews follow pushes instead.
	if (!session.prUrl || session.review || isWorking(session.id)) return false;
	// The user stopped the agent: new comments wait on the pull request until their next message starts a reply,
	// which clears the stop, rather than starting the agent again behind their back.
	if (session.stoppedAt) return false;
	const project = await getProject(session.projectId);
	const state = stateFor(session);
	if (!project?.followUps || state.done || state.sent >= MAX_FOLLOW_UPS) return false;
	const activity = read ?? (await readPullRequest({ ...session, prUrl: session.prUrl }));
	const save = (next: FollowState) => updateSession(session.id, { followState: JSON.stringify({ ...next, url: session.prUrl }) });
	if (activity.state === 'merged' || activity.state === 'closed') {
		// Never looked at again, so finished tasks cost no requests on every poll.
		await save({ ...state, done: true });
		return false;
	}
	const unseen = unseenComments(activity, state);
	const held = heldBack(unseen, (await generalSettings()).fixLowFindings);
	const quiet = [...held, ...(await askingNothing(session.id, unseen.filter((comment) => !held.includes(comment.id))))];
	const next = nextFollowUp(session.prUrl, activity, state, quiet, session.baseBranch);
	if (next.message) await sendToAgent(session.id, next.message);
	if (next.state !== state) await save(next.state);
	return next.message !== null;
}

export async function resetFollowUps(id: string): Promise<void> {
	const session = await getSessionRecord(id);
	if (!session?.followState) return;
	const state = stateFor(session);
	if (state.sent > 0) await updateSession(id, { followState: JSON.stringify({ ...state, sent: 0 }) });
}

export async function runFollowUps(): Promise<void> {
	if ((await budget()).blocked) return;
	for (const session of (await listSessionRecords()).filter((record) => record.prUrl)) {
		await followUp(session).catch((error: unknown) => logProblem('warn', 'Pull request follow-up failed', error, session.id));
	}
}
