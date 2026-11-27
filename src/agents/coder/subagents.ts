import { defineSubagent, useSubagent } from '@flue/runtime';
import { agentSettingsNow, helperModelFor } from '../../services/tasks/agent-runner.ts';
import { repoInstructionsFor } from '../../services/settings/plugins.ts';
import { agentKeepsContext, COMPACTION_SUMMARY_EFFORT, compactionFor } from '../../services/context/context-usage.ts';
import { OUTPUTS, repoInstructionsPrompt } from './prompts.ts';
import { useRepoSnapshot } from './tools/snapshot.ts';
import { useRunScript } from './tools/run-script.ts';
import { REVIEW_RUBRIC, REVIEW_SCOPE, REVIEW_TESTS, REVIEW_TRUST } from '../../services/git/code-review.ts';
import { joinedFor, requestFor } from '../../services/replies/finish-review.ts';
import { reviewerRan } from '../../services/replies/reviewer-runs.ts';

/**
 * Prod, Nov 2026, 106 explorer runs: median 7 steps and 140k tokens, p90 11 steps and 270k; the runs past that read
 * whole files (up to 238KB, 725k tokens), and a 2,400-token report took 30 s to write.
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

const MAX_REVIEW_REQUEST = 3_000;

/**
 * The brief is written by the agent whose change it is: in prod it stated requirements the user never asked for and sent
 * the reviewer hunting for holes in them. So the reviewer reads the user's own words, and weighs the brief's claims against them.
 */
export function reviewerRequest(request: string | undefined, joined: readonly string[] = []): string {
	const text = request?.trim();
	if (!text) return '';
	const clip = (value: string) => (value.length > MAX_REVIEW_REQUEST ? `${value.slice(0, MAX_REVIEW_REQUEST)}…` : value);
	// In prod a user asked twice mid-reply for only the new tests; the reviewer, never told, ran the full suites into five timeouts.
	const later = joined.map((message) => message.trim()).filter(Boolean);
	return (
		`The user asked for this change in these words:\n<request>\n${clip(text)}\n</request>\n` +
		(later.length
			? `While the work went on, the user added:\n${later.map((message) => `<message>\n${clip(message)}\n</message>`).join('\n')}\nThese narrow or redirect the request, and bind you too, including how they say to run the tests.\n`
			: '') +
		"Judge the change against that request. Your brief is the author's account of the change: where it adds requirements the request does not make, treat them as the author's to check, not as rules the change must meet."
	);
}

/** Asked for before a push (`src/services/replies/pre-push-review.ts`): the pull request reviewer's rubric, its findings handed to the Coder. */
function ChangeReviewer(request?: string, joined: readonly string[] = []) {
	return [
		'You are the reviewer specialist. You review a change before it is pushed, with fresh eyes: you have not seen how it was written.',
		'Read the diff your brief names with git diff, then the surrounding code, callers and tests you need to judge it. You may run read-only commands and the tests; change no files, and do not commit or push.',
		REVIEW_TESTS,
		...(request ? [reviewerRequest(request, joined)] : []),
		REVIEW_RUBRIC,
		REVIEW_TRUST,
		REVIEW_SCOPE,
		'Report each problem most severe first, each as its severity (critical, high, medium or low), file and line, the problem, why it matters and how to fix it; then say in one line what you checked. With no problems, say so in one line. Keep it to about 400 words.',
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
 * Without its own model a subagent uses the task's, and its compaction. One on a Claude Code model compacts where
 * Settings › General says Claude Code compacts (scripts/patch-flue.ts reads `compaction`), not near the end of a 1M window.
 */
export function withSettingsModel(id: string, subagent: typeof explorer, name: 'explorer' | 'tester' | 'reviewer' | 'browser' | 'computer'): typeof explorer {
	const choice = helperModelFor(id, name);
	if (!choice) return subagent;
	const compaction = agentKeepsContext(choice.model) ? false : choice.model.startsWith('claude-code/') ? compactionFor(choice.model) : { reasoning: COMPACTION_SUMMARY_EFFORT };
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

/** Before a chat, plan or review has a sandbox, its explorer reads the snapshot, so reading never starts a machine. */
export function useSnapshotExplorer(id: string, chat: boolean) {
	const subagent = defineSubagent({
		name: 'explorer',
		description: chat
			? `Read-only investigation of GitHub repositories (name each as owner/name in the brief), reporting its findings with files and lines. ${EXPLORER_USE}`
			: `Read-only investigation of the repository as the task started, or of another GitHub repository the brief names as owner/name, reporting its findings with files and lines. ${EXPLORER_USE}`,
		agent: () => {
			useRepoSnapshot(id, chat);
			const scripts = agentSettingsNow().codeMode;
			if (scripts) useRunScript(id, { repo: true, mcp: false });
			return SnapshotExplorer(scripts, chat);
		},
	});
	useSubagent(withSettingsModel(id, subagent, 'explorer'));
}

/** One explorer for the whole task: read, grep and glob answer from the snapshot until the workspace exists. */
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

/** The runtime gives these no repository instructions here, so they get the task's. */
export function useTaskSubagents(id: string) {
	const taskExplorer = defineSubagent({
		name: 'explorer',
		description: `Read-only investigation of the repository, or of another GitHub repository the brief names as owner/name, answering with its findings with files and lines. ${EXPLORER_USE}`,
		agent: () => {
			const scripts = agentSettingsNow().codeMode;
			if (scripts) useRunScript(id, { repo: 'task', mcp: false });
			return TaskExplorer(id, scripts);
		},
	});
	const taskTester = defineSubagent({ ...tester, agent: () => `${Tester()}${repoInstructionsPrompt(repoInstructionsFor(id))}` });
	useSubagent(withSettingsModel(id, taskExplorer, 'explorer'));
	useSubagent(withSettingsModel(id, taskTester, 'tester'));
	const reviewer = defineSubagent({
		name: 'reviewer',
		description:
			"Reviews a change with fresh eyes before it is pushed, read-only, once a reply, and answers with the problems it confirmed, each with a severity. It starts without this conversation but is given the user's request: brief it with what the change does and the git diff range to read.",
		agent: () => `${ChangeReviewer(requestFor(id), joinedFor(id))}${repoInstructionsPrompt(repoInstructionsFor(id))}`,
	});
	// Once a reply: past that, what it finds goes to the user rather than into another round.
	if (!reviewerRan(id)) useSubagent(withSettingsModel(id, reviewer, 'reviewer'));
}
