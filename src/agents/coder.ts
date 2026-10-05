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
	useSkill,
	useSubagent,
	useTool,
} from '@flue/runtime';
import * as v from 'valibot';
import { machineSandbox } from '../flue/machine-sandbox.ts';
import { liveOpenRouterProvider } from '../flue/live-models.ts';
import { saveCheckpoint } from '../services/checkpoints.ts';
import { repoDir } from '../services/git.ts';
import { browse, takeScreenshot } from '../services/browser.ts';
import { openPullRequest } from '../services/pull-requests.ts';
import { modelFor } from '../services/sessions.ts';
import { toUsage } from '../services/usage.ts';
import { agentSettingsNow, hasWorkspace, isPlanning, mcpServersFor, memoryFor } from '../services/agent-runner.ts';
import { hasScriptTools, runScript, scriptToolDescription } from '../services/code-mode.ts';
import { remember } from '../services/memory.ts';
import { repoInstructionsFor, skillsFor } from '../services/plugins.ts';
import { secretsToHide } from '../services/secrets.ts';
import { listRepoFiles, readRepoFile, searchRepo } from '../services/repo-snapshot.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { loadedModels } from '../services/models.ts';
import { liveMachine, machineFor } from '../services/workspace.ts';
import { logProblem } from '../services/log.ts';

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

/** A subagent's own model from Settings, often a cheaper one; without one it uses the task's. */
function withSettingsModel(subagent: typeof explorer, name: 'explorer' | 'tester'): typeof explorer {
	const choice = agentSettingsNow().models[name];
	return choice ? { ...subagent, model: choice.model, thinkingLevel: choice.reasoning } : subagent;
}

/** Tools for answering from the repo at the task's base commit, with no sandbox, clone or branch. */
function useReadOnlyRepo(id: string, startWorkspace: (() => void) | null) {
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
	if (startWorkspace) useStartWorkspace(id, startWorkspace);
}

function useStartWorkspace(id: string, startWorkspace: () => void) {
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

/**
 * The sandbox and everything that needs it: shell and file tools, subagents,
 * pull requests, and a browser to use web apps in. In plan mode the file tools cannot write and
 * there is no pull request.
 */
function useWorkspace(id: string, planning: boolean) {
	useSandbox({
		async createSandbox() {
			const [machine, secrets] = await Promise.all([machineFor(id), secretsToHide(id)]);
			return machineSandbox(machine, repoDir(machine), () => !isPlanning(id), secrets);
		},
	});
	useSubagent(withSettingsModel(explorer, 'explorer'));
	useSubagent(withSettingsModel(tester, 'tester'));
	if (!planning) useOpenPullRequest(id);
	useTool(browserTool(id));
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

const BROWSER_ACTIONS = ['open', 'click', 'type', 'select', 'press', 'hover', 'scroll', 'back', 'wait', 'look'] as const;

/** One step in a browser tab inside the sandbox that stays open between steps, for checking a web app the way a person would. */
function browserTool(id: string) {
	return defineTool({
		name: 'browser',
		description:
			'Use a web page in a browser inside the sandbox, one step per call: open a URL, click, type, select, press a key, hover, scroll, go back, wait, or look. ' +
			'The tab stays open between calls, so the page keeps its state. Each call returns the URL, title, any failure, console errors, ' +
			'and the page as an accessibility tree (roles, names, text). Target elements with Playwright selectors from that tree, such as ' +
			'role=button[name="Save"], role=textbox[name="Email"], text=Sign in, or CSS. Pass screenshot to save a PNG to the outputs folder; read it to see the page.',
		input: v.object({
			action: v.picklist(BROWSER_ACTIONS),
			url: v.optional(v.pipe(v.string(), v.description('For open: usually a dev server in the sandbox, such as http://localhost:3000'))),
			target: v.optional(v.pipe(v.string(), v.description('The element to act on, as a Playwright selector'))),
			text: v.optional(v.pipe(v.string(), v.description('For type: what to enter, replacing what is there. For select: the option'))),
			submit: v.optional(v.pipe(v.boolean(), v.description('For type: press Enter afterwards'))),
			key: v.optional(v.pipe(v.string(), v.description('For press: such as Enter, Escape, Tab or Control+a'))),
			amount: v.optional(v.pipe(v.number(), v.description('For scroll: pixels down, negative for up'))),
			ms: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(15_000), v.description('For wait without a target'))),
			screenshot: v.optional(v.pipe(v.string(), v.description('Save a screenshot after the step, under this short name'))),
			fullPage: v.optional(v.boolean()),
			width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(320), v.maxValue(2560))),
			height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(320), v.maxValue(2560))),
		}),
		async run({ data }) {
			return { output: await browse(await machineFor(id), data) };
		},
	});
}

function useOpenPullRequest(id: string) {
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
}

/** Code mode: one program that calls many tools, with only its result coming back; on in Settings > General. */
function useRunScript(id: string, workspace: boolean) {
	useTool(
		defineTool({
			name: 'run_script',
			description: scriptToolDescription(id, workspace),
			input: v.object({ code: v.pipe(v.string(), v.minLength(1), v.description('The body of an async JavaScript function')) }),
			run: async ({ data, signal }) => ({ output: await runScript(id, data.code, { workspace, signal }) }),
		}),
	);
}

/** Adds a note to the repo's memory, which every later task reads. */
function useRemember(id: string) {
	useTool(
		defineTool({
			name: 'remember',
			description:
				'Save one short, lasting fact about this repository for future tasks: how to run or test it, a convention, a gotcha you hit. ' +
				'Not details of this task, and nothing secret.',
			input: v.object({ note: v.pipe(v.string(), v.minLength(1), v.description('One line')) }),
			run: async ({ data }) => ({ output: await remember(id, data.note) }),
		}),
	);
}

/** The repo's own skills and the installed plugins' skills; the agent loads one when a task matches its description. */
function useSkills(id: string, workspace: boolean) {
	for (const skill of skillsFor(id, workspace)) useSkill(skill);
}

/** The repo's AGENTS.md and CLAUDE.md while read-only; with a sandbox, the runtime reads them from the repo itself. */
function repoInstructionsPrompt(instructions: string): string {
	return instructions ? `\n\nThe repository's own instructions for agents (AGENTS.md, CLAUDE.md):\n${instructions}` : '';
}

/** The repo's notes, as part of the instructions; written by earlier tasks and the user. */
function memoryPrompt(memory: string): string {
	return memory ? `\n\nNotes about this repository from earlier tasks and the user (they may be out of date; trust the code):\n${memory}` : '';
}

/** Plan mode's way out: the plan is shown with an Approve button, and approving it turns plan mode off. */
const proposePlan = defineTool({
	name: 'propose_plan',
	description: 'Show the user your plan for approval. Call it once the plan is ready, then stop and wait.',
	input: v.object({
		plan: v.pipe(v.string(), v.minLength(1), v.description('The plan in markdown: what will change, where, and how it will be checked')),
	}),
	run: async () => ({ output: 'The user sees the plan with an Approve button. Stop here; they will approve it or ask for changes.' }),
});

const REMEMBER_HINT = 'When you learn something about this repository that a later task would otherwise have to rediscover, save it with remember.';

const SKILL_HINT = 'When the user names a skill, such as /pdf or "use the pdf skill", activate that skill before you start.';

const MENTION_HINT = 'When the user writes @ and a path, such as @src/app.ts, they mean that file in the repository.';

const SCRIPT_HINT =
	'When a job needs several reads, searches or web lookups, or results you only need part of, write one run_script program instead of many separate tool calls.';

const WEB_HINT = 'When you need documentation, an error message explained or anything outside the repo, use the web_search and web_fetch tools if you have them.';

const READ_ONLY_PROMPT = [
	'You are Anton, a coding agent for a GitHub repository.',
	'You start read-only, with no sandbox: answer questions about the code with list_files, search_code and read_file, which show the repository at the commit this task started from.',
	'When the task needs more (editing files, running commands or tests, installing anything, or opening a pull request), call start_workspace first, then carry on.',
	'Do not start a workspace for questions you can answer by reading.',
	WEB_HINT,
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
	'Check UI changes in the browser: open the page, click and type through what you changed, and take a screenshot to read; use the screenshot tool for a quick full-page capture.',
	WEB_HINT,
	'Be concise. Explain what you changed.',
].join(' ');

const PLAN_PROMPT = [
	'Plan mode is on: investigate as much as you need, but change nothing.',
	'File writes are refused, and you must not run commands that change files, install packages, commit or push.',
	'When you understand the work, call the propose_plan tool with a concrete plan: the files you will change and how, and how you will check the result.',
	'Always present the plan through propose_plan, not as a reply, so the user can approve it; keep any reply after it to a line or two.',
	'Then stop. Once the user approves, plan mode turns off and you carry out the plan.',
	'If they ask for changes, revise the plan and propose it again.',
].join(' ');

/**
 * A task starts read-only: questions are answered from a copy of the repo
 * on Anton's side, with no sandbox, clone or branch. The agent opens the
 * workspace when the work needs one, and a task that has had a machine
 * (from the agent, the terminal, Resume or a restore) keeps working there.
 * In plan mode it may look but not change anything until its plan is approved.
 */
export function Coder({ id }: AgentProps) {
	const { model, reasoning } = modelFor(id);
	useModel(model, { thinkingLevel: reasoning });
	const [started, setStarted] = usePersistentState('workspace', false);
	const workspace = started || hasWorkspace(id);
	const planning = isPlanning(id);
	if (workspace) useWorkspace(id, planning);
	else useReadOnlyRepo(id, planning ? null : () => setStarted(true));
	if (planning) useTool(proposePlan);
	const scripts = agentSettingsNow().codeMode && hasScriptTools(id, workspace);
	if (scripts) useRunScript(id, workspace);
	useRemember(id);
	useSkills(id, workspace);
	// Web search and the repo's MCP servers; one that cannot be reached leaves its tools out rather than failing the reply.
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
			logProblem('warn', 'Checkpoint failed', error, id);
		}
	});
	// Shown on the reply; the task's totals are counted per model call from the runtime's events.
	useResponseFinish(({ response }) => ({ usage: toUsage(response.usage) }));
	const prompt = workspace ? WORKSPACE_PROMPT : READ_ONLY_PROMPT;
	const instructions = workspace ? '' : repoInstructionsPrompt(repoInstructionsFor(id));
	return `${planning ? `${prompt} ${PLAN_PROMPT}` : prompt} ${scripts ? `${SCRIPT_HINT} ` : ''}${MENTION_HINT} ${REMEMBER_HINT} ${SKILL_HINT}${instructions}${memoryPrompt(memoryFor(id))}`;
}
