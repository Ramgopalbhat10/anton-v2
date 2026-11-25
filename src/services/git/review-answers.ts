import { InvalidInputError } from '../../core/errors.ts';
import { ANSWER_MARK, answerBody, answersPrComments, commentIdsIn, type Verdict } from '../../core/review-follow-up.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { getProviders } from '../../providers/index.ts';
import { changeGate, gate, loadGate } from '../replies/gate-state.ts';

/*
 * Prod, Nov 2026 (thread 880a8d8d): the agent could only answer review comments in the thread, so the reviewer never heard
 * which findings it fixed and which it disputed, and every reply began "the comment was right". Answering each comment
 * where it was made gives the agent a way to push back, the next review the author's side, and the user the argument on
 * the pull request, as code review tools do.
 */

const MAX_NOTE = 1_500;
const MAX_COMMENT = 800;
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

/** The pull request's review threads as text for the agent: open ones by default, each with its replies, by the id answers take. */
export async function readReviewThreads(id: string, { all = false }: { all?: boolean } = {}): Promise<string> {
	const session = await getSessionRecord(id);
	if (!session?.prUrl) throw new InvalidInputError('This task has no pull request.');
	const { git } = getProviders();
	if (!git.reviewThreads) return 'Review threads cannot be read on this host.';
	const threads = await git.reviewThreads(session.prUrl);
	const shown = all ? threads : threads.filter((thread) => !thread.resolved);
	if (shown.length === 0) return threads.length ? `All ${threads.length} review threads are resolved.` : 'The pull request has no review threads.';
	const blocks = shown.map((thread) => {
		const state = [thread.resolved ? 'resolved' : 'open', thread.outdated ? 'outdated: its lines have changed since' : null].filter(Boolean).join(', ');
		const comments = thread.comments.map((comment) => `  @${comment.author}: ${clip(comment.body.replace(ANSWER_MARK, '').trim(), MAX_COMMENT).replace(/\n/g, '\n  ')}`);
		return [`[${thread.id}] ${thread.path}${thread.line ? `:${thread.line}` : ''} (${state})`, ...comments].join('\n');
	});
	const hidden = threads.length - shown.length;
	return [...blocks, ...(hidden ? [`${hidden} resolved thread${hidden === 1 ? '' : 's'} not shown; pass all to see them.`] : [])].join('\n\n');
}

export type Answer = { comment: string; verdict: Verdict; note: string };

export async function answerReviewComment(id: string, { comment, verdict, note }: Answer): Promise<string> {
	const session = await getSessionRecord(id);
	if (!session?.prUrl) throw new InvalidInputError('This task has no pull request to answer comments on.');
	if (!/^(?:line|comment|review)-\d+$/.test(comment)) throw new InvalidInputError(`Unknown comment "${comment}": pass the id in brackets from the list of comments, such as line-123.`);
	const text = note.trim().slice(0, MAX_NOTE);
	if (!text) throw new InvalidInputError('Say what you changed, why you did not, or what the user needs to decide.');
	const { git } = getProviders();
	if (!git.answerComment) return 'Answers cannot be posted on this host. Give each one in your reply instead.';
	await git.answerComment(session.prUrl, comment, answerBody(verdict, text), verdict !== 'question');
	await loadGate(id);
	changeGate(id, (state) => {
		state.answered = [...new Set([...(state.answered ?? []), comment])];
	});
	return verdict === 'question'
		? 'Posted on the pull request; its thread stays open for the user. Once every comment is answered and the pull request updated, end your reply by asking the user with the ask tool, with two to four options to pick from.'
		: `Posted on the pull request and marked the thread resolved${comment.startsWith('line-') ? '' : ' (a comment without a thread is answered on the pull request)'}.`;
}

export function startReviewAnswers(id: string): void {
	changeGate(id, (state) => {
		state.answered = [];
		state.answersAsked = false;
	});
}

/** Null unless this reply answers review comments and some are still unanswered; asked once a reply. */
export async function reviewAnswersGate(id: string): Promise<string | null> {
	await loadGate(id);
	const { request, answered = [], answersAsked } = gate(id);
	if (answersAsked || !answersPrComments(request)) return null;
	const missing = commentIdsIn(request).filter((comment) => !answered.includes(comment));
	if (missing.length === 0) return null;
	changeGate(id, (state) => {
		state.answersAsked = true;
	});
	return [
		`Before Anton pushes, answer each review comment on the pull request with answer_review_comment. Still unanswered: ${missing.join(', ')}.`,
		'Use fixed with what you changed, declined with why the comment does not hold or is out of scope, or question with what the user must decide. Then end your reply, with the ask tool if one is a question for the user.',
	].join(' ');
}
