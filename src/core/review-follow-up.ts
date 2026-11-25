/** How Anton's message carrying new pull request comments begins (`commentsMessage` in src/services/git/follow-ups.ts). */
export const PR_COMMENTS_HEAD = 'New comments on your pull request';

/** A reply sent to answer review comments: the pull request's own re-review reads what it pushes. */
export const answersPrComments = (request: string | undefined): boolean =>
	Boolean(request && (request.startsWith(`${PR_COMMENTS_HEAD} (`) || request.includes(`\n\n${PR_COMMENTS_HEAD} (`)));

/** On every answer Anton posts, so follow-ups never send the agent its own answers. */
export const ANSWER_MARK = '<!-- anton-answer -->';

export const VERDICTS = ['fixed', 'declined', 'question'] as const;
export type Verdict = (typeof VERDICTS)[number];

const VERDICT_LABEL: Record<Verdict, string> = { fixed: 'Fixed', declined: 'Not changed', question: 'Needs your decision' };

export function answerBody(verdict: Verdict, note: string): string {
	return `**${VERDICT_LABEL[verdict]}:** ${note.trim()}\n\n${ANSWER_MARK}`;
}

/** The verdict and note of an answer Anton posted; null for any other comment. */
export function answerOf(body: string): { verdict: Verdict; note: string } | null {
	if (!body.includes(ANSWER_MARK)) return null;
	const match = /^\*\*(Fixed|Not changed|Needs your decision):\*\*\s*([\s\S]*?)\s*<!-- anton-answer -->/.exec(body.trim());
	if (!match) return null;
	const verdict = (Object.keys(VERDICT_LABEL) as Verdict[]).find((key) => VERDICT_LABEL[key] === match[1])!;
	return { verdict, note: match[2].trim() };
}

/** The ids `commentsMessage` lists, as `[line-123]`, in the order given. */
export const commentIdsIn = (text: string | undefined): string[] => [...new Set([...(text ?? '').matchAll(/^\d+\. \[((?:line|comment|review)-\d+)\]/gm)].map((match) => match[1]))];
