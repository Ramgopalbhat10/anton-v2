'use agent';

import { type AgentProps, useModel, useSandbox, useTool } from '@flue/runtime';
import { machineSandbox } from '../flue/machine-sandbox.ts';
import { helperModelFor } from '../services/agent-runner.ts';
import { REVIEW_GUIDE } from '../services/code-review.ts';
import { compactionFor } from '../services/context-usage.ts';
import { fullResultTool } from '../services/tool-results.ts';
import { postReviewTool } from './review-tool.ts';
import { repoDir } from '../services/git.ts';
import { secretsToHide } from '../services/secrets.ts';
import { modelFor } from '../services/sessions.ts';
import { machineFor } from '../services/workspace.ts';
// Registers the model providers (OpenRouter, Vercel, the plans) before this agent resolves a model.
import './providers.ts';

const PROMPT = [
	"You are Anton's code reviewer. The coding agent working on this task has opened or updated a pull request from this repository's task branch, and you review it before a person does.",
	'You may run read-only commands such as git, grep and the tests. Change no files, and do not commit, push, check out other branches or install anything.',
	REVIEW_GUIDE,
].join(' ');

/**
 * Reads a task's pull request in the task's own sandbox and posts what it
 * finds; it can look and run commands but not change files. It is its own
 * conversation, so the coder never sees how it reasoned, only its comments.
 */
export function Reviewer({ id }: AgentProps) {
	// Its own model — the project's when the task is a thread, else Settings › General's — or the task's.
	const { model, reasoning } = helperModelFor(id, 'reviewer') ?? modelFor(id);
	useModel(model, { thinkingLevel: reasoning, compaction: compactionFor(model) });
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
