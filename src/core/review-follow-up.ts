/** How Anton's message carrying new pull request comments begins (`commentsMessage` in src/services/git/follow-ups.ts). */
export const PR_COMMENTS_HEAD = 'New comments on your pull request';

/** A reply sent to answer review comments: the pull request's own re-review reads what it pushes. */
export const answersPrComments = (request: string | undefined): boolean =>
	Boolean(request && (request.startsWith(`${PR_COMMENTS_HEAD} (`) || request.includes(`\n\n${PR_COMMENTS_HEAD} (`)));
