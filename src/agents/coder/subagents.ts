import { defineSubagent, useSubagent } from '@flue/runtime';
import { agentSettingsNow, helperModelFor } from '../../services/tasks/agent-runner.ts';
import { repoInstructionsFor } from '../../services/settings/plugins.ts';
import { COMPACTION_SUMMARY_EFFORT, compactionFor } from '../../services/context/context-usage.ts';
import { OUTPUTS, repoInstructionsPrompt } from './prompts.ts';
import { useRepoSnapshot } from './tools/snapshot.ts';
import { useRunScript } from './tools/run-script.ts';

/**
 * What every explorer is told, whichever files it reads. In prod (Nov 2026, 106 explorer runs) one took 7 steps and
 * 140k tokens at the median and 11 steps and 270k at the 90th percentile; the runs past that grew their context with
 * whole files (two explorers of one reply read 238KB and 219KB and spent 639k and 725k tokens), and a 2,400-token
 * final report took 30 s to write. Nothing told them when to stop or how long to answer.
 */
const EXPLORER_SCOPE =
	'Answer the questions in your brief and nothing past them: once each is answered, or you see it cannot be answered from here, stop reading and report. ' +
	'Most briefs need fewer than ten steps; past that, report what you have rather than widening the search.';
const EXPLORER_READING =
	'Search before you open files, then read only the lines that bear on the question, not whole large files: everything you read is sent again with each later step. ' +
	'You cannot reach the web, so name anything only online documentation could settle.';
const EXPLORER_SCRIPTS =
	'When the next step is several reads or searches you can name now (every match of a search, each file of a folder), do them in one run_script program and return only the parts you need.';
// The task call hands the final message back to the Coder, so a report file is only extra writing and reading.
const findingsReport = (canWrite: boolean) =>
	'Report in about 500 words or fewer unless the brief asks for more: each finding with its files and lines and what they show, then what you could not settle.' +
	(canWrite ? ` Write ${OUTPUTS}/explorer-report.md only when the brief asks for a report. Do not commit, push, or open a pull request.` : '');

/** Says what the Coder gets from an explorer and what it costs, in every explorer's description. */
const EXPLORER_USE =
	'It starts without this conversation, cannot reach the web, and the caller waits for its report: use it for an investigation across many files you cannot name yet, not for a few files you can.';

function Explorer() {
	return [
		'You are the explorer specialist.',
		'Investigate the repository with read, grep and glob, and with bash only for what reading cannot answer, such as git history; you change nothing.',
		EXPLORER_SCOPE,
		EXPLORER_READING,
		findingsReport(true),
	].join(' ');
}

function Tester() {
	return [
		'You are the tester specialist.',
		'Detect how this repo runs tests (package.json, Makefile, pytest, go test, cargo test).',
		'Run the test suite. Capture failures.',
		`Answer with a short summary: the command, pass and fail counts, and each failure with its error. Write ${OUTPUTS}/test-report.md only when the brief asks for a report.`,
		'Put any script, log or screenshot you make to run the tests in /tmp, not in the repository.',
		'Do not commit, push, or open a pull request.',
	].join(' ');
}

export const explorer = defineSubagent({
	name: 'explorer',
	description: `Read-only investigation of the repository, answering with its findings with files and lines. ${EXPLORER_USE}`,
	agent: Explorer,
});

export const tester = defineSubagent({
	name: 'tester',
	description: 'Runs the project test suite and answers with a summary of its failures.',
	agent: Tester,
});

/**
 * A subagent's own model — its project's choice when the task is a thread, else Settings › General's —
 * often a cheaper one; without one it uses the task's, and its compaction. One on a
 * Claude Code model compacts where Settings › General says Claude Code compacts (scripts/patch-flue.ts
 * reads its `compaction`), not near the end of a 1M window; others keep the runtime's point for their model,
 * and their own model writes their summary at the effort the task's own model writes one.
 */
export function withSettingsModel(id: string, subagent: typeof explorer, name: 'explorer' | 'tester' | 'browser' | 'computer'): typeof explorer {
	const choice = helperModelFor(id, name);
	if (!choice) return subagent;
	const compaction = choice.model.startsWith('claude-code/') ? compactionFor(choice.model) : { reasoning: COMPACTION_SUMMARY_EFFORT };
	return { ...subagent, model: choice.model, thinkingLevel: choice.reasoning, compaction } as typeof explorer;
}

function SnapshotExplorer(scripts: boolean, chat: boolean) {
	return [
		'You are the explorer specialist.',
		chat
			? 'Investigate the GitHub repositories your brief names with list_files, search_code and read_file, passing each call the repository as repo; you change nothing.'
			: 'Investigate the repository with list_files, search_code and read_file, which show it at the commit this task started from (or, given repo, another GitHub repository); you change nothing.',
		EXPLORER_SCOPE,
		EXPLORER_READING,
		...(scripts ? [EXPLORER_SCRIPTS] : []),
		findingsReport(false),
	].join(' ');
}

/**
 * Before a chat, plan or review has a sandbox, the explorer reads the same
 * snapshot the agent answers from, so reading many files stays out of the
 * agent's context without starting a machine. With a sandbox, `useWorkspace`
 * mounts the explorer that works there instead.
 */
export function useSnapshotExplorer(id: string, chat: boolean) {
	const subagent = defineSubagent({
		name: 'explorer',
		description: chat
			? `Read-only investigation of GitHub repositories (name each as owner/name in the brief), reporting its findings with files and lines. ${EXPLORER_USE}`
			: `Read-only investigation of the repository as the task started, or of another GitHub repository the brief names as owner/name, reporting its findings with files and lines. ${EXPLORER_USE}`,
		agent: () => {
			useRepoSnapshot(id, chat);
			// Its job is many reads, which is what code mode is for; it has no MCP servers of its own.
			const scripts = agentSettingsNow().codeMode;
			if (scripts) useRunScript(id, { repo: true, mcp: false });
			return SnapshotExplorer(scripts, chat);
		},
	});
	useSubagent(withSettingsModel(id, subagent, 'explorer'));
}

/**
 * A repository task's explorer, one definition for the whole task: it reads with read, grep and glob, which answer
 * from the snapshot until the task has its workspace and from the sandbox after, so reading never starts a machine.
 * It shares the sandbox's tools as every subagent does, bash among them, for what reading cannot answer.
 */
function TaskExplorer(id: string, scripts: boolean) {
	return (
		[
			'You are the explorer specialist.',
			"Investigate with read, grep and glob, which show the task's files (or, given repo, another GitHub repository's) and need no sandbox; you change nothing.",
			'Use bash only for what reading cannot answer, such as git history: it starts the sandbox.',
			EXPLORER_SCOPE,
			EXPLORER_READING,
			...(scripts ? [EXPLORER_SCRIPTS] : []),
			findingsReport(true),
		].join(' ') + repoInstructionsPrompt(repoInstructionsFor(id))
	);
}

/** A repository task's explorer and tester; the runtime gives them no repository instructions of its own here, so they get the task's. */
export function useTaskSubagents(id: string) {
	const taskExplorer = defineSubagent({
		name: 'explorer',
		description: `Read-only investigation of the repository, or of another GitHub repository the brief names as owner/name, answering with its findings with files and lines. ${EXPLORER_USE}`,
		agent: () => {
			// Its job is many reads, which is what code mode is for; it has no MCP servers of its own.
			const scripts = agentSettingsNow().codeMode;
			if (scripts) useRunScript(id, { repo: 'task', mcp: false });
			return TaskExplorer(id, scripts);
		},
	});
	const taskTester = defineSubagent({ ...tester, agent: () => `${Tester()}${repoInstructionsPrompt(repoInstructionsFor(id))}` });
	useSubagent(withSettingsModel(id, taskExplorer, 'explorer'));
	useSubagent(withSettingsModel(id, taskTester, 'tester'));
}
