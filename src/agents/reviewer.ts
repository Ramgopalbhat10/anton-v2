'use agent';

import { type AgentProps, setProvider, useModel, useSandbox, useTool } from '@flue/runtime';
import { machineSandbox } from '../flue/machine-sandbox.ts';
import { liveOpenRouterProvider } from '../flue/live-models.ts';
import { claudeCodeProvider, cursorProvider } from '../flue/claude-code-models.ts';
import { openCodeGoProvider } from '../flue/opencode-go-models.ts';
import { chatGptPlanProvider } from '../flue/subscription-models.ts';
import { agentSettingsNow } from '../services/agent-runner.ts';
import { REVIEW_GUIDE } from '../services/code-review.ts';
import { postReviewTool } from './review-tool.ts';
import { repoDir } from '../services/git.ts';
import { loadedModels } from '../services/models.ts';
import { gatewayToken, planKey, planRuntime, runtimeFor, runtimeHooks } from '../services/subscriptions.ts';
import { secretsToHide } from '../services/secrets.ts';
import { modelFor } from '../services/sessions.ts';
import { machineFor } from '../services/workspace.ts';

setProvider(liveOpenRouterProvider(loadedModels));
setProvider(chatGptPlanProvider(loadedModels, () => gatewayToken('openai')));
setProvider(claudeCodeProvider(loadedModels, () => runtimeFor('claude-code'), runtimeHooks('claude-code')));
setProvider(openCodeGoProvider(loadedModels, () => planKey('opencode-go')));
setProvider(cursorProvider(loadedModels, () => planRuntime('cursor'), runtimeHooks('cursor')));

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
