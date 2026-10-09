'use agent';

import { type AgentProps, defineTool, setProvider, useModel, useSandbox, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { machineSandbox } from '../flue/machine-sandbox.ts';
import { liveOpenRouterProvider } from '../flue/live-models.ts';
import { chatGptPlanProvider } from '../flue/subscription-models.ts';
import { agentSettingsNow } from '../services/agent-runner.ts';
import { postReview } from '../services/code-review.ts';
import { repoDir } from '../services/git.ts';
import { loadedModels } from '../services/models.ts';
import { gatewayToken } from '../services/subscriptions.ts';
import { secretsToHide } from '../services/secrets.ts';
import { modelFor } from '../services/sessions.ts';
import { machineFor } from '../services/workspace.ts';

setProvider(liveOpenRouterProvider(loadedModels));
setProvider(chatGptPlanProvider(loadedModels, () => gatewayToken('openai')));

const PROMPT = [
	"You are Anton's code reviewer. The coding agent working on this task has opened or updated a pull request from this repository's task branch, and you review it before a person does.",
	'Review the change, not the whole repository: read the diff, then read the surrounding code, callers and tests you need to judge it.',
	"If the repository has a REVIEW.md, follow it; its AGENTS.md and CLAUDE.md rules apply too.",
	'Report only problems a careful reviewer would ask to fix before merging: bugs and wrong behavior, security issues, data loss, unhandled failures that matter, changed behavior with no test where the repository tests that kind of code, and clear breaks of the repository\'s written rules.',
	'Leave out style, naming and matters of taste unless REVIEW.md asks for them. Confirm each problem in the code before you report it, and drop anything you are not sure of.',
	'You may run read-only commands such as git, grep and the tests. Change no files, and do not commit, push, check out other branches or install anything.',
	'Finish by calling post_review once. Put each finding on the line it is about, a line of the new file that the change added or modified. With no findings, call it with an empty list.',
	'When this conversation has earlier reviews, report a problem again only if it is still there.',
].join(' ');

const postReviewTool = (id: string) =>
	defineTool({
		name: 'post_review',
		description: 'Post your review on the pull request: a short summary and one comment per problem. Call it once, at the end.',
		input: v.object({
			summary: v.pipe(v.string(), v.description('One to three sentences: what the change does and whether it is ready')),
			findings: v.pipe(
				v.array(
					v.object({
						path: v.pipe(v.string(), v.minLength(1), v.description('File path relative to the repository root')),
						line: v.pipe(v.number(), v.integer(), v.minValue(1), v.description('Line in the new version of the file, on a line the change added or modified')),
						body: v.pipe(v.string(), v.minLength(1), v.description('The problem, why it matters, and how to fix it')),
					}),
				),
				v.maxLength(20),
			),
		}),
		run: async ({ data }) => ({ output: await postReview(id, data) }),
	});

/**
 * Reads a task's pull request in the task's own sandbox and posts what it
 * finds; it can look and run commands but not change files. It is its own
 * conversation, so the coder never sees how it reasoned, only its comments.
 */
export function Reviewer({ id }: AgentProps) {
	// Its own model from Settings, or the task's.
	const { model, reasoning } = agentSettingsNow().models.reviewer ?? modelFor(id);
	useModel(model, { thinkingLevel: reasoning });
	useSandbox({
		async createSandbox() {
			const [machine, secrets] = await Promise.all([machineFor(id), secretsToHide(id)]);
			return machineSandbox(machine, repoDir(machine), () => false, secrets, 'You are reviewing: files cannot be changed. Describe the fix in your review instead.');
		},
	});
	useTool(postReviewTool(id));
	return PROMPT;
}
