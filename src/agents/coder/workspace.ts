import { defineTool, useSandbox, useSubagent, useTool, type Sandbox } from '@flue/runtime';
import * as v from 'valibot';
import type { Machine } from '../../core/ports.ts';
import type { ToolProfile } from '../../core/tool-profile.ts';
import { machineSandbox } from '../../flue/machine-sandbox.ts';
import { type ImageSight, sandboxTools } from '../../flue/sandbox-tools.ts';
import { taskSandbox, taskTools } from '../../flue/task-sandbox.ts';
import { repoDir } from '../../services/git/git.ts';
import { takeScreenshot } from '../../services/browser/browser.ts';
import { modelFor } from '../../services/tasks/sessions.ts';
import { isPlanning, noteWorkspace, type ReviewTask } from '../../services/tasks/agent-runner.ts';
import { postReviewTool } from '../review-tool.ts';
import { pluginSkillsFor } from '../../services/settings/plugins.ts';
import { copySkillFilesSoon } from '../../services/sandbox/skill-files.ts';
import { secretsToHide } from '../../services/secrets/secrets.ts';
import { globTask, grepTask, readTaskFile, taskFileBytes, taskRoot, workMachine } from '../../services/sandbox/task-files.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { findModel } from '../../services/models/models.ts';
import { machineFor } from '../../services/sandbox/workspace.ts';
import { checkPreview } from '../../services/browser/preview-check.ts';
import { describeImage } from '../../services/models/vision.ts';
import { logProblem } from '../../core/log.ts';
import { elapsedNote } from '../../services/replies/reply-clock.ts';
import { checkJob, jobNotice, MAX_WAIT_S, startJob } from '../../services/sandbox/background-jobs.ts';
import { checkNotice } from '../../services/sandbox/repo-check.ts';
import { explorer, tester, withSettingsModel, useTaskSubagents } from './subagents.ts';
import { useAnswerReviewComment, useOpenPullRequest, useMergeBaseBranch, useReadReviewComments } from './tools/git.ts';

export function useStartWorkspace(id: string, chat: boolean, startWorkspace: () => void) {
	useTool(
		defineTool({
			name: 'start_workspace',
			description: chat
				? 'Start a scratch sandbox for this chat: an empty folder with a shell, not a repository. ' +
					'Call it before running code or commands, making files, or installing anything. Takes a minute.'
				: 'Start this task\'s sandbox: a clone of the repository on its own branch, with a shell. ' +
					'Call it before editing files, running commands or tests, or opening a pull request. Takes a minute or two.',
			input: v.object({ reason: v.pipe(v.string(), v.description('What you need the workspace for, in a few words')) }),
			async run() {
				await machineFor(id);
				startWorkspace();
				if (chat) return { output: 'Scratch sandbox ready, with an empty folder as your working directory. Your shell and file editing tools are available from your next step.' };
				const session = await getSessionRecord(id);
				return { output: `Workspace ready on branch ${session?.branch}. Your shell and file editing tools are available from your next step.` };
			},
		}),
	);
}

function sightOf(id: string): ImageSight {
	return {
		sees: async () => (await findModel(modelFor(id).model).catch(() => undefined))?.vision === true,
		describe: (bytes, mimeType) => describeImage(id, bytes, mimeType),
	};
}

async function sandboxOf(id: string, machine: Machine): Promise<Sandbox> {
	const secrets = await secretsToHide(id);
	copySkillFilesSoon(id, machine, pluginSkillsFor(id), (error) => logProblem('warn', "Could not copy the skills' files into the sandbox", error, id));
	return machineSandbox(machine, repoDir(machine), () => !isPlanning(id), secrets, undefined, () => elapsedNote(id) + jobNotice(id) + checkNotice(id));
}

/** A chat's, plan's or review's sandbox, once it has one. A repository task outside plan mode and review uses `useTaskWorkspace`. */
export function useWorkspace(id: string, chat: boolean, review: ReviewTask | null, profile: ToolProfile) {
	useSandbox({
		createSandbox: async () => sandboxOf(id, await machineFor(id)),
		tools: sandboxTools(sightOf(id), profile),
	});
	useBackgroundJobs(id);
	if (!chat) {
		useSubagent(withSettingsModel(id, explorer, 'explorer'));
		useSubagent(withSettingsModel(id, tester, 'tester'));
		if (review) useTool(postReviewTool(id));
	}
	useSandboxChecks(id);
}

/** From the first model call, so tools and prompt never change; nothing here starts a machine before a tool needs one. */
export function useTaskWorkspace(id: string, profile: ToolProfile) {
	useSandbox({
		async createSandbox() {
			let started: Promise<Sandbox> | undefined;
			const machine = async (work: boolean): Promise<Sandbox> => {
				started ??= machineFor(id)
					.then((found) => sandboxOf(id, found))
					.catch((error: unknown) => {
						started = undefined;
						throw error;
					});
				const sandbox = await started;
				if (work) noteWorkspace(id);
				return sandbox;
			};
			return taskSandbox(await taskRoot(id), machine);
		},
		tools: taskTools(
			{
				read: (input) => readTaskFile(id, input),
				bytes: (path, repo) => taskFileBytes(id, path, repo),
				grep: (input) => grepTask(id, input),
				glob: (input) => globTask(id, input),
			},
			sightOf(id),
			profile,
		),
	});
	useBackgroundJobs(id, (task) => workMachine(task));
	useTaskSubagents(id);
	useOpenPullRequest(id);
	useAnswerReviewComment(id);
	useReadReviewComments(id);
	useMergeBaseBranch(id);
	useSandboxChecks(id);
}

function useSandboxChecks(id: string) {
	useTool(
		defineTool({
			name: 'check_preview',
			description: 'Check a configured Preview port and obtain the exact URL used by the Preview panel. For public URLs, requests it from Anton’s server and reports HTTP status, final URL and framing headers; this is not a browser rendering check. Local listening only means a TCP connection inside the sandbox worked. Does not start a sandbox.',
			input: v.object({ port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535), v.description('The configured Preview port the app is running on')) }),
			async run({ data }) {
				return { output: await checkPreview(id, data.port) };
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

function useBackgroundJobs(id: string, machine?: (id: string) => Promise<Machine>) {
	useTool(
		defineTool({
			name: 'run_in_background',
			description:
				'Run a command that ends (a test suite, build, type check or long script) in the background in the working folder; returns at once with its job number and log. ' +
				'You are told when it ends. A server that should keep running is started with nohup instead.',
			input: v.object({
				command: v.pipe(v.string(), v.minLength(1)),
				timeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.description('Seconds before it is stopped (default 1800)'))),
			}),
			async run({ data }) {
				try {
					return { output: (await startJob(id, data.command, data.timeout, machine ? { machine } : {})).output };
				} catch (error) {
					return { output: `The job did not start. ${error instanceof Error ? error.message : String(error)}` };
				}
			},
		}),
	);
	useTool(
		defineTool({
			name: 'check_job',
			description: "A background job's status, exit code and time, with its log's failure lines and last lines. wait blocks up to that many seconds for it to end; stop kills it.",
			input: v.object({
				job: v.pipe(v.number(), v.integer(), v.minValue(1)),
				wait: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_WAIT_S))),
				stop: v.optional(v.boolean()),
			}),
			run: async ({ data, signal }) => ({ output: await checkJob(id, data.job, { wait: data.wait, stop: data.stop, signal }) }),
		}),
	);
}
