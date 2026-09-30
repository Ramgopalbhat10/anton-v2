'use agent';

import { defineSubagent, defineTool, useModel, useSandbox, useSubagent, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { ensureAccessToken, githubClientFromEnv } from '../lib/auth.ts';
import { appDb } from '../lib/db-app.ts';
import { env } from '../lib/env.ts';
import { cwdForConversation, openWorkspacePullRequest, projectByWorkspace } from '../lib/sessions.ts';

function Explorer() {
	return [
		'You are the explorer specialist.',
		'Investigate the repository using read, grep, glob, and bash.',
		'Do not modify source files except agent/explorer-report.md.',
		'Write a concise findings report to agent/explorer-report.md, then stop.',
		'Do not commit, push, or open a pull request.',
	].join(' ');
}

function Tester() {
	return [
		'You are the tester specialist.',
		'Detect how this repo runs tests (package.json, Makefile, pytest, go test, cargo test).',
		'Run the test suite. Capture failures.',
		'Write a summary to agent/test-report.md.',
		'Do not commit, push, or open a pull request.',
	].join(' ');
}

const explorer = defineSubagent({
	name: 'explorer',
	description: 'Read-only codebase investigation. Writes agent/explorer-report.md.',
	agent: Explorer,
});

const tester = defineSubagent({
	name: 'tester',
	description: 'Runs the project test suite and writes agent/test-report.md.',
	agent: Tester,
});

const openPullRequest = defineTool({
	name: 'open_pull_request',
	description:
		'Commit remaining changes, then open a pull request. In local mode this creates a commit and returns a local:// reference. With GitHub configured it pushes and opens a PR on the session repository.',
	harness: true,
	async run({ harness }) {
		const url = await openWorkspacePullRequest(harness.sandbox.cwd, 'feat: anton agent changes');
		return { output: { url, message: 'Recorded pull request target.' } };
	},
});

export function Coder() {
	useModel(env.defaultModel);
	useSandbox({
		async createSandbox({ id }) {
			const cwd = cwdForConversation(id) ?? process.cwd();
			let token: string | undefined;
			const project = await projectByWorkspace(cwd);
			if (project && project.userId !== 'user_dev') {
				try {
					token = await ensureAccessToken(project.userId, appDb(), githubClientFromEnv());
				} catch {
					token = undefined;
				}
			}
			return local({
				cwd,
				env: {
					...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
					OPENROUTER_API_KEY: undefined,
				},
			}).createSandbox({ id });
		},
	});
	useSubagent(explorer);
	useSubagent(tester);
	useTool(openPullRequest);
	return [
		'You are Anton, an autonomous coding agent working in a real git workspace.',
		'The sandbox filesystem is the source of truth. Edit files, run commands, and inspect git there.',
		'Delegate read-heavy investigation to the explorer subagent and test runs to the tester subagent.',
		'Give each task a complete briefing; subagents do not see this conversation.',
		'Do not run explorer and tester in parallel if both would write git state. Report files in agent/ are fine in parallel.',
		'You own commits and pull requests. Call open_pull_request when the user wants a PR.',
		'Be concise. Explain what you changed.',
	].join(' ');
}
