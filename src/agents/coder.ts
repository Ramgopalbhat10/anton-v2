'use agent';

import {
	type AgentProps,
	defineSubagent,
	defineTool,
	setProvider,
	useAgentFinish,
	useMcpConnection,
	useModel,
	usePersistentState,
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
import { toUsage } from '../services/usage.ts';
import { hasWorkspace, mcpServersFor } from '../services/agent-runner.ts';
import { listRepoFiles, readRepoFile, searchRepo } from '../services/repo-snapshot.ts';
import { getSessionRecord } from '../db/sessions.ts';
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

/** Tools for answering from the repo at the task's base commit, with no sandbox, clone or branch. */
function useReadOnlyRepo(id: string, startWorkspace: () => void) {
	const filter = {
		path: v.optional(v.pipe(v.string(), v.description('Only under this folder, relative to the repo root'))),
		glob: v.optional(v.pipe(v.string(), v.description('Only paths matching this glob, such as **/*.ts or package.json'))),
	};
	useTool(
		defineTool({
			name: 'list_files',
			description: 'List file paths in the repository, optionally under a folder or matching a glob.',
			input: v.object(filter),
			run: async ({ data }) => ({ output: await listRepoFiles(id, data) }),
		}),
	);
	useTool(
		defineTool({
			name: 'read_file',
			description: 'Read a file of the repository with line numbers. Long files come in pages; pass offset to read on.',
			input: v.object({
				path: v.pipe(v.string(), v.minLength(1), v.description('Path relative to the repo root')),
				offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.description('First line to show'))),
				limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2000))),
			}),
			run: async ({ data }) => ({ output: await readRepoFile(id, data.path, data.offset, data.limit) }),
		}),
	);
	useTool(
		defineTool({
			name: 'search_code',
			description: 'Search file contents with a regular expression. Returns path:line: text for each match.',
			input: v.object({
				pattern: v.pipe(v.string(), v.minLength(1), v.description('JavaScript regular expression')),
				ignoreCase: v.optional(v.boolean()),
				...filter,
			}),
			run: async ({ data }) => ({ output: await searchRepo(id, data) }),
		}),
	);
	useTool(
		defineTool({
			name: 'start_workspace',
			description:
				'Start this task\'s sandbox: a clone of the repository on its own branch, with a shell. ' +
				'Call it before editing files, running commands or tests, or opening a pull request. Takes a minute or two.',
			input: v.object({ reason: v.pipe(v.string(), v.description('What you need the workspace for, in a few words')) }),
			async run() {
				await machineFor(id);
				startWorkspace();
				const session = await getSessionRecord(id);
				return { output: `Workspace ready on branch ${session?.branch}. Your shell and file editing tools are available from your next step.` };
			},
		}),
	);
}

/** The sandbox and everything that needs it: shell and file tools, subagents, pull requests and screenshots. */
function useWorkspace(id: string) {
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
}

const READ_ONLY_PROMPT = [
	'You are Anton, a coding agent for a GitHub repository.',
	'You start read-only, with no sandbox: answer questions about the code with list_files, search_code and read_file, which show the repository at the commit this task started from.',
	'When the task needs more (editing files, running commands or tests, installing anything, or opening a pull request), call start_workspace first, then carry on.',
	'Do not start a workspace for questions you can answer by reading.',
	'Be concise, and point to files and lines.',
].join(' ');

const WORKSPACE_PROMPT = [
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

/**
 * A task starts read-only: questions are answered from a copy of the repo
 * on Anton's side, with no sandbox, clone or branch. The agent opens the
 * workspace when the work needs one, and a task that has had a machine
 * (from the agent, the terminal, Resume or a restore) keeps working there.
 */
export function Coder({ id }: AgentProps) {
	const { model, reasoning } = modelFor(id);
	useModel(model, { thinkingLevel: reasoning });
	const [started, setStarted] = usePersistentState('workspace', false);
	const workspace = started || hasWorkspace(id);
	if (workspace) useWorkspace(id);
	else useReadOnlyRepo(id, () => setStarted(true));
	// The repo's MCP servers; one that cannot be reached leaves its tools out rather than failing the reply.
	for (const server of mcpServersFor(id)) {
		useMcpConnection({
			name: server.name,
			url: server.url,
			...(server.auth ? { auth: server.auth } : {}),
			...(server.tools.length ? { tools: server.tools } : {}),
			optional: true,
		});
	}
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
	// Shown on the reply; the task's totals are counted per model call from the runtime's events.
	useResponseFinish(({ response }) => ({ usage: toUsage(response.usage) }));
	return workspace ? WORKSPACE_PROMPT : READ_ONLY_PROMPT;
}
