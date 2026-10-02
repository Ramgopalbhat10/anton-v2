'use agent';

import {
	type AgentProps,
	defineSubagent,
	defineTool,
	setProvider,
	useAgentFinish,
	useModel,
	useResponseFinish,
	useSandbox,
	useSubagent,
	useTool,
} from '@flue/runtime';
import * as v from 'valibot';
import { machineSandbox } from '../flue/machine-sandbox.ts';
import { liveOpenRouterProvider } from '../flue/live-models.ts';
import { saveCheckpoint } from '../services/checkpoints.ts';
import { repoDir } from '../services/git.ts';
import { takeScreenshot } from '../services/browser.ts';
import { openPullRequest } from '../services/pull-requests.ts';
import { modelFor } from '../services/sessions.ts';
import { recordUsage, toUsage } from '../services/usage.ts';
import { loadedModels } from '../services/models.ts';
import { liveMachine, machineFor } from '../services/workspace.ts';

// Any model in OpenRouter's live list resolves, not only those pi knew when it was published.
setProvider(liveOpenRouterProvider(loadedModels));

/** Deliverables go here, outside the repo, so they never pollute the diff. */
const OUTPUTS = '../outputs';

function Explorer() {
	return [
		'You are the explorer specialist.',
		'Investigate the repository using read, grep, glob, and bash.',
		'Do not modify files in the repository.',
		`Write a concise findings report to ${OUTPUTS}/explorer-report.md, then stop.`,
		'Do not commit, push, or open a pull request.',
	].join(' ');
}

function Tester() {
	return [
		'You are the tester specialist.',
		'Detect how this repo runs tests (package.json, Makefile, pytest, go test, cargo test).',
		'Run the test suite. Capture failures.',
		`Write a summary to ${OUTPUTS}/test-report.md.`,
		'Do not commit, push, or open a pull request.',
	].join(' ');
}

const explorer = defineSubagent({
	name: 'explorer',
	description: `Read-only codebase investigation. Writes ${OUTPUTS}/explorer-report.md.`,
	agent: Explorer,
});

const tester = defineSubagent({
	name: 'tester',
	description: `Runs the project test suite and writes ${OUTPUTS}/test-report.md.`,
	agent: Tester,
});

export function Coder({ id }: AgentProps) {
	const { model, reasoning } = modelFor(id);
	useModel(model, { thinkingLevel: reasoning });
	useSandbox({
		async createSandbox() {
			const machine = await machineFor(id);
			return machineSandbox(machine, repoDir(machine));
		},
	});
	useSubagent(explorer);
	useSubagent(tester);
	useTool(
		defineTool({
			name: 'open_pull_request',
			description: 'Commit all changes on this task branch, push it, and open a pull request. Returns the pull request URL.',
			input: v.object({
				title: v.pipe(v.string(), v.minLength(1), v.description('Pull request title, in the imperative mood')),
				body: v.pipe(v.string(), v.description('What changed and why, in markdown')),
			}),
			async run({ data }) {
				return { output: { url: await openPullRequest(id, data) } };
			},
		}),
	);
	useTool(
		defineTool({
			name: 'screenshot',
			description:
				'Open a URL in a headless browser inside the sandbox and save a PNG to the outputs folder, where the user sees it in the Library. ' +
				'Returns the file path, page title, HTTP status and console errors. Read the PNG to look at it.',
			input: v.object({
				url: v.pipe(v.string(), v.description('Usually a dev server in the sandbox, such as http://localhost:3000')),
				name: v.optional(v.pipe(v.string(), v.description('Short file name, without extension'))),
				fullPage: v.optional(v.pipe(v.boolean(), v.description('Capture the whole scrollable page'))),
				width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(320), v.maxValue(2560))),
				height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(320), v.maxValue(2560))),
			}),
			async run({ data }) {
				return { output: await takeScreenshot(await machineFor(id), data) };
			},
		}),
	);
	// Every finished response leaves a checkpoint, so the task can be viewed after its machine stops.
	// Only a running machine: a task stopped or deleted mid-response is never started again for this.
	useAgentFinish(async () => {
		try {
			const machine = await liveMachine(id);
			if (machine) await saveCheckpoint(id, machine);
		} catch (error) {
			console.warn('[anton] checkpoint failed', error);
		}
	});
	// Each reply carries its own usage for the thread; the task keeps a running total.
	useResponseFinish(({ response }) => {
		const usage = toUsage(response.usage);
		recordUsage(id, usage);
		return { usage };
	});
	return [
		'You are Anton, an autonomous coding agent working in a real git repository on its own task branch.',
		'The sandbox filesystem is the source of truth. Edit files, run commands, and inspect git there.',
		`Save deliverables that are not code (screenshots, reports, exports) to ${OUTPUTS}; the user sees them in the Library.`,
		'Delegate read-heavy investigation to the explorer subagent and test runs to the tester subagent.',
		'Give each task a complete briefing; subagents do not see this conversation.',
		'You do not have git push credentials. Call open_pull_request when the user wants a pull request; it commits and pushes for you.',
		'To run a web app, bind its dev server to 0.0.0.0 on one of the ports in $ANTON_PREVIEW_PORTS and start it in the background with its output in a log file (`nohup <command> > /tmp/dev.log 2>&1 &`); the user can open it from the Preview panel.',
		'Check UI changes with the screenshot tool, then read the image to see the result.',
		'Be concise. Explain what you changed.',
	].join(' ');
}
