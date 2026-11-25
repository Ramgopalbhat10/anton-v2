import { defineTool, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { queuePullRequest } from '../../../services/replies/push-gate.ts';
import { noteWorkspace } from '../../../services/tasks/agent-runner.ts';
import { mergeBaseBranch } from '../../../services/git/base-merge.ts';
import { answerReviewComment } from '../../../services/git/review-answers.ts';
import { VERDICTS } from '../../../core/review-follow-up.ts';

export function useOpenPullRequest(id: string) {
	useTool(
		defineTool({
			name: 'open_pull_request',
			description:
				'Commit all changes on this task branch and queue its pull request. Anton pushes the branch and opens the pull request, or updates the open one, once, when your reply ends and its checks pass. ' +
				'Call it once the change works; later commits go with the same push. Call it again only to change the title or description.',
			input: v.object({
				title: v.pipe(v.string(), v.minLength(1), v.description('Pull request title, in the imperative mood')),
				body: v.pipe(v.string(), v.description('What changed and why, in markdown')),
			}),
			async run({ data }) {
				return { output: await queuePullRequest(id, data) };
			},
		}),
	);
}

export function useMergeBaseBranch(id: string) {
	useTool(
		defineTool({
			name: 'merge_base_branch',
			description:
				"Merge the latest base branch from GitHub into this task branch, for when the pull request has merge conflicts or falls behind. " +
				'Commit your own changes first. Conflicts are left in the files for you to resolve, git add and commit; then call open_pull_request.',
			input: v.object({}),
			async run() {
				// It changes the files, so the task's reads come from its sandbox from now on.
				noteWorkspace(id);
				return { output: await mergeBaseBranch(id) };
			},
		}),
	);
}

export function useAnswerReviewComment(id: string) {
	useTool(
		defineTool({
			name: 'answer_review_comment',
			description:
				'Answer one review comment on your pull request where it was made, by the id in brackets from the list of comments. ' +
				'fixed: say what you changed. declined: say why the comment does not hold or is out of scope; a reviewer can be wrong. question: say what the user must decide. ' +
				'Fixed and declined threads are marked resolved; the next review reads your answers.',
			input: v.object({
				comment: v.pipe(v.string(), v.description('The comment id in brackets, such as line-123')),
				verdict: v.pipe(v.picklist(VERDICTS), v.description('fixed, declined or question')),
				note: v.pipe(v.string(), v.minLength(1), v.description('One or two sentences for the reviewer and the user')),
			}),
			async run({ data }) {
				return { output: await answerReviewComment(id, data) };
			},
		}),
	);
}
