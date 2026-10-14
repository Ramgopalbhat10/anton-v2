import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { postReview, SEVERITIES } from '../services/code-review.ts';

/** Posts a review on the task's pull request; the reviewer's on Anton's own, the coder's in a task reviewing someone else's. */
export const postReviewTool = (id: string) =>
	defineTool({
		name: 'post_review',
		description: 'Post your review on the pull request: a short summary and one comment per problem, most severe first. Call it once, at the end.',
		input: v.object({
			summary: v.pipe(v.string(), v.description('One to three sentences: what the change does and whether it is ready')),
			findings: v.pipe(
				v.array(
					v.object({
						path: v.pipe(v.string(), v.minLength(1), v.description('File path relative to the repository root')),
						line: v.pipe(v.number(), v.integer(), v.minValue(1), v.description('Line in the new version of the file, on a line the change added or modified')),
						kind: v.pipe(v.picklist(['bug', 'security']), v.description('security for a problem an attacker can use; bug for anything else')),
						severity: v.pipe(v.picklist(SEVERITIES), v.description('How bad it is if it ships')),
						body: v.pipe(v.string(), v.minLength(1), v.description('The problem, why it matters, and how to fix it')),
						exploit: v.optional(
							v.pipe(v.string(), v.description('For a security finding: who can trigger it, through what input, and what they gain')),
						),
					}),
				),
				v.maxLength(20),
			),
		}),
		run: async ({ data }) => ({ output: await postReview(id, data) }),
	});
