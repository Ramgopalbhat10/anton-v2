import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { PullRequestComment } from '../core/ports.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { sendToAgent } from './agent-runner.ts';
import { generalSettings } from './general.ts';
import { logProblem } from './log.ts';

/** Ends every review Anton posts, so it can count its own reviews on a pull request. */
export const REVIEW_MARK = '<!-- anton-review -->';
/** Ends a review that found nothing, which follow-ups never send to the agent. */
export const CLEAN_MARK = '<!-- anton-review:clean -->';
/** Automatic reviews of one pull request; a fix that keeps drawing findings then waits for a person. */
export const MAX_REVIEWS = 3;

const isAntonReview = (comment: PullRequestComment) => comment.id.startsWith('review-') && (comment.body.includes(REVIEW_MARK) || comment.body.includes(CLEAN_MARK));

/** The head each task's reviewer is reading, so its line comments land on the lines it read. */
const reviewing = new Map<string, string>();

function reviewMessage(url: string, baseSha: string, head: string): string {
	return [
		`Review the pull request ${url} at ${head.slice(0, 7)}.`,
		`The change is \`git diff ${baseSha}...${head}\` in the repository, and \`git log ${baseSha}..${head}\` lists its commits.`,
		'Call post_review once when you are done.',
	].join('\n');
}

/**
 * Asks the task's reviewer agent to review its pull request at the head on
 * the host. Automatic requests, made each time the agent opens or updates a
 * pull request, follow the setting and stop after MAX_REVIEWS; asking by hand
 * always reviews.
 */
export async function requestReview(id: string, { automatic }: { automatic: boolean }): Promise<boolean> {
	const session = await getSessionRecord(id);
	if (!session) throw new NotFoundError('Session not found');
	if (!session.prUrl) throw new InvalidInputError('This task has no pull request to review.');
	if (automatic && !(await generalSettings()).reviewPullRequests) return false;
	const activity = await getProviders().git.pullRequestActivity(session.prUrl);
	if (activity.state === 'merged' || activity.state === 'closed') {
		if (automatic) return false;
		throw new InvalidInputError(`The pull request is ${activity.state}.`);
	}
	if (automatic && activity.comments.filter(isAntonReview).length >= MAX_REVIEWS) return false;
	reviewing.set(id, activity.headSha);
	await sendToAgent(id, reviewMessage(session.prUrl, session.baseSha, activity.headSha), 'reviewer');
	return true;
}

/** Reviews the pull request the agent just opened or updated, if reviews are on; never fails the push. */
export function reviewAfterPush(id: string): void {
	requestReview(id, { automatic: true }).catch((error: unknown) => logProblem('warn', 'Could not start the pull request review', error, id));
}

export type Finding = { path: string; line: number; body: string };

/** Posts the reviewer's findings on the task's pull request; follow-ups then send them to the agent to fix. */
export async function postReview(id: string, { summary, findings }: { summary: string; findings: Finding[] }): Promise<string> {
	const session = await getSessionRecord(id);
	if (!session?.prUrl) throw new NotFoundError('This task has no pull request');
	const clean = findings.length === 0;
	const heading = clean ? '**Anton review:** no problems found.' : `**Anton review:** ${findings.length === 1 ? '1 problem' : `${findings.length} problems`} to fix.`;
	await getProviders().git.postReview(session.prUrl, {
		commit: reviewing.get(id) ?? null,
		body: [heading, summary.trim(), clean ? CLEAN_MARK : REVIEW_MARK].filter(Boolean).join('\n\n'),
		comments: findings.map((finding) => ({ path: finding.path.replace(/^\.?\//, ''), line: finding.line, body: finding.body.trim() })),
	});
	return clean ? 'Posted: no problems found. You are done.' : `Posted ${findings.length} finding${findings.length === 1 ? '' : 's'} on the pull request. You are done.`;
}
