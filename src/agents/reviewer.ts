'use agent';

import { type AgentProps, useModel, useSandbox, useTool } from '@flue/runtime';
import { machineSandbox } from '../flue/machine-sandbox.ts';
import { helperModelFor } from '../services/tasks/agent-runner.ts';
import { REVIEW_GUIDE, REVIEW_TESTS } from '../services/git/code-review.ts';
import { agentCompaction } from '../services/context/context-usage.ts';
import { fullResultTool } from '../services/context/tool-results.ts';
import { postReviewTool } from './review-tool.ts';
import { repoDir } from '../services/git/git.ts';
import { secretsToHide } from '../services/secrets/secrets.ts';
import { modelFor } from '../services/tasks/sessions.ts';
import { machineFor } from '../services/sandbox/workspace.ts';
// Registers the model providers before this agent resolves a model.
import './providers.ts';

const PROMPT = [
	"You are Anton's code reviewer. The coding agent working on this task has opened or updated a pull request from this repository's task branch, and you review it before a person does.",
	'You may run read-only commands such as git, grep and the tests. Change no files, and do not commit, push, check out other branches or install anything.',
	REVIEW_TESTS,
	REVIEW_GUIDE,
].join(' ');

/** Its own conversation, so the coder never sees how it reasoned, only its comments. */
export function Reviewer({ id }: AgentProps) {
	const { model, reasoning } = helperModelFor(id, 'reviewer') ?? modelFor(id);
	useModel(model, { thinkingLevel: reasoning, compaction: agentCompaction(model) });
	useSandbox({
		async createSandbox() {
			const [machine, secrets] = await Promise.all([machineFor(id), secretsToHide(id)]);
			return machineSandbox(machine, repoDir(machine), () => false, secrets, 'You are reviewing: files cannot be changed. Describe the fix in your review instead.');
		},
	});
	useTool(postReviewTool(id));
	useTool(fullResultTool(id));
	return PROMPT;
}
