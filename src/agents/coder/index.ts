'use agent';

import {
	type AgentProps,
	useAgentFinish,
	useAgentStart,
	useDelivery,
	useMcpConnection,
	useModel,
	usePersistentState,
	useResponseFinish,
	useResponseStart,
	useTool,
} from '@flue/runtime';
import { config } from '../../config.ts';
import { toolProfileFor } from '../../core/tool-profile.ts';
import { saveCheckpoint } from '../../services/git/checkpoints.ts';
import { agentModelFor } from '../../services/tasks/sessions.ts';
import { toUsage } from '../../services/models/usage.ts';
import {
	agentSettingsNow,
	hasWorkspace,
	isChat,
	isPlanning,
	connectorsFor,
	runsOnHost,
	sealedSecretsFor,
	mcpServersFor,
	memoryFor,
	reviewTaskFor,
	threadProjectFor,
} from '../../services/tasks/agent-runner.ts';
import { directServer, hasScriptTools, type ScriptScope } from '../../services/sandbox/code-mode.ts';
import { startTodoReply, todoReminder } from '../../services/replies/todos.ts';
import { imagesAvailable } from '../../services/artifacts/images.ts';
import { repoInstructionsFor } from '../../services/settings/plugins.ts';
import { onPlan, planOf } from '../../services/models/subscriptions.ts';
import { finishReply, replyFacts, replyTotal, startReply } from '../../services/models/response-usage.ts';
import { finishTrace, startTrace } from '../../services/context/response-trace.ts';
import { saveTrace } from '../../db/traces.ts';
import { compactionFor } from '../../services/context/context-usage.ts';
import { fullResultTool } from '../../services/context/tool-results.ts';
import { liveMachine, machineFor } from '../../services/sandbox/workspace.ts';
import { prewarmFor } from '../../services/sandbox/prewarm-intent.ts';
import { sharedBrowserAvailable } from '../../services/browser/live-browser.ts';
import { isIncognitoId } from '../../core/incognito.ts';
import { logProblem } from '../../core/log.ts';
import { recordLatestInput } from '../../services/tasks/latest-input.ts';
import { noteDelivery } from '../../services/tasks/joins.ts';
import { checkReply, stallReminder, startStallCheck } from '../../services/replies/reply-check.ts';
import { finishReview, isRequest, noteRequest, startFinishReview } from '../../services/replies/finish-review.ts';
import { takePinned } from '../../services/replies/compaction-pin.ts';
import { type GateName, loadGate } from '../../services/replies/gate-state.ts';
import { noteSendBack, sendBacksOf, settleSendBacks, startSendBacks } from '../../services/replies/send-backs.ts';
import { startReplyClock } from '../../services/replies/reply-clock.ts';
import { completionGate, startCompletionGate } from '../../services/replies/completion-gate.ts';
import { jobsGate, startJobsGate, stopReplyJobs } from '../../services/sandbox/background-jobs.ts';
import { checkGate, startCheckGate, stopRepoCheck, watchRepoCheck } from '../../services/sandbox/repo-check.ts';
import { whenIdle } from '../../services/tasks/activity.ts';
import { replyNotice } from '../../services/notify/push.ts';
import { replyNotification } from '../../services/notify/notifications.ts';
import { threadFinished } from '../../services/projects/thread-reports.ts';
import { saveSpaceFiles } from '../../services/projects/space-files.ts';
import {
	IMAGE_HINT,
	sealedHint,
	connectorHint,
	attachmentHint,
	projectPrompt,
	repoInstructionsPrompt,
	memoryPrompt,
	TODO_HINT,
	WHILE_WORKING_HINT,
	APP_HINT,
	REMEMBER_HINT,
	skillHint,
	hostHint,
	MENTION_HINT,
	visualHint,
	SCRIPT_HINT,
	SCRIPTED_MCP_HINT,
	BROWSER_HINT,
	COMPUTER_HINT,
	REQUIREMENTS_HINT,
	READ_ONLY_PROMPT,
	CHAT_PROMPT,
	PROMPTS,
	INCOGNITO_PROMPT,
	reviewPrompt,
	PLAN_PROMPT,
} from './prompts.ts';
import { useSnapshotExplorer } from './subagents.ts';
import { useStartWorkspace, useWorkspace, useTaskWorkspace } from './workspace.ts';
import { useRepoSnapshot } from './tools/snapshot.ts';
import { type BrowserPlace, useBrowserSubagent } from './tools/browser.ts';
import { useComputerSubagent } from './tools/computer.ts';
import { useRunScript } from './tools/run-script.ts';
import { useRemember, useAgentRuns, useTodos } from './tools/memory.ts';
import { useAsk, useShow, useRenderHtml, useGenerateImage } from './tools/replies.ts';
import { useProjectFiles, useReadAttachment, useSkills } from './tools/files.ts';
import { useConnectorTools, useHttpRequest } from './tools/connectors.ts';
import { useProposePlan } from './tools/plan.ts';
// Registers the model providers (OpenRouter, Vercel, the plans) before this agent resolves a model.
import '../providers.ts';

/**
 * Keeps the task's latest input for its card: each message the agent is given, typed, a follow-up or an
 * automation's, as it starts a reply or joins one already running, and where in that reply a joining one
 * was read. The runtime emits no event for them.
 *
 * Only the message that starts a reply is its request, which the checks at the reply's end and the compaction
 * pin hold the agent to. One sent while the reply runs ("are you stuck?") joins it and is answered within it:
 * it fires `useAgentStart` again but not `useResponseStart`, so it is never taken for the request.
 */
function useLatestInput(id: string) {
	const delivery = useDelivery();
	useResponseStart(() => {
		if (delivery.kind === 'user') noteRequest(id, delivery.body);
	});
	useAgentStart(() => {
		if (delivery.kind !== 'user') return;
		// The card's bookkeeping: the reply starts without waiting on the database, which can be busy for seconds.
		inBackground(id, Promise.all([noteDelivery(id, delivery.body), recordLatestInput(id, delivery.body)]));
	});
}

/** Each task's bookkeeping writes still in hand, which what the reply leaves is written after (`followUp`). */
const bookkeeping = new Map<string, Promise<unknown>>();

function inBackground(id: string, work: Promise<unknown>): void {
	const next = Promise.all([bookkeeping.get(id), work]).catch(() => undefined);
	bookkeeping.set(id, next);
	void next.then(() => {
		if (bookkeeping.get(id) === next) bookkeeping.delete(id);
	});
}

/** Each task's latest checkpoint write: the next one waits for it, so two never read and write the same checkpoint at once. */
const checkpoints = new Map<string, Promise<void>>();

function queueCheckpoint(id: string): void {
	const next = (checkpoints.get(id) ?? Promise.resolve()).then(async () => {
		try {
			const machine = await liveMachine(id);
			if (machine) {
				await saveCheckpoint(id, machine);
				// What the reply changed in ../project-files reaches the project's Library, for every thread.
				await saveSpaceFiles(machine, id).catch((error: unknown) => logProblem('warn', 'Could not save the project files', error, id));
			}
		} catch (error) {
			logProblem('warn', 'Checkpoint failed', error, id);
		}
	});
	checkpoints.set(id, next);
	void next.then(() => {
		if (checkpoints.get(id) === next) checkpoints.delete(id);
	});
}

/** Tasks whose reply has ended and waits to settle before what it leaves is judged. */
const followingUp = new Set<string>();

/** Once a reply has settled: whether it waits on you, then a project's thread reports and frees its slot, then your phone hears. */
async function followUp(id: string): Promise<void> {
	// The message's write clears what the task was asking; what this reply asks is written after it.
	await bookkeeping.get(id);
	const reply = await checkReply(id);
	await threadFinished(id, reply).catch((error: unknown) => logProblem('warn', 'Could not report the thread', error, id));
	// After it is judged done or not, so the row says Done rather than Replied.
	await replyNotification(id, reply);
	await replyNotice(id, reply);
}

/**
 * A repository task has its whole tool list and one system prompt from its first model call: it reads from a copy
 * of the repo on Anton's side, with no sandbox, clone or branch, until its first command or change starts the
 * machine, and a task that has had a machine (from the agent, the terminal, Resume or a restore) reads there. A
 * chat, and a plan or review before its sandbox, read the copy with their own tools and open the workspace with
 * `start_workspace`. In plan mode the agent may look but not change anything until its plan is approved.
 */
export function Coder({ id }: AgentProps) {
	// With a route, the gateway tries the task's provider first or ranks them by its sort.
	const { model, reasoning } = agentModelFor(id);
	// A long conversation compacts at the ceiling from Settings › General, not only once the window is nearly full.
	useModel(model, { thinkingLevel: reasoning, compaction: compactionFor(model) });
	// The tools that change files, and the prompts that name them, are the model family's: the same while the model is.
	const profile = toolProfileFor(model, config.toolProfile);
	const prompts = PROMPTS[profile];
	const [started, setStarted] = usePersistentState('workspace', false);
	const workspace = started || hasWorkspace(id);
	// An incognito chat is a chat with nothing kept: no repository, no workspace, no sandbox, no saved state.
	const incognito = isIncognitoId(id);
	// A chat has no repository: no snapshot to read, notes to keep or pull request to open.
	const chat = isChat(id) || incognito;
	const planning = isPlanning(id);
	const review = reviewTaskFor(id);
	// A repository task outside plan mode and review: one system prompt and one tool list from its first model call to its last.
	const repoTask = !chat && !planning && !review;
	// Whether the prompt and tools offer the sandbox: a repository task gets it on first use, so from the start; the rest once they have it.
	const sandboxed = repoTask || workspace;
	// The repository's check runs after its changes only here: never for a chat, a plan, a review or a task on this server.
	watchRepoCheck(id, repoTask && !runsOnHost(id));
	if (repoTask) useTaskWorkspace(id, profile);
	else if (workspace) useWorkspace(id, chat, review, profile);
	else if (!incognito) {
		// A chat reads other repositories with the same tools, named by repo.
		useRepoSnapshot(id, chat);
		useSnapshotExplorer(id, chat);
		if (!planning) useStartWorkspace(id, chat, () => setStarted(true));
	}
	if (planning) useProposePlan(id);
	// Code mode's repo tools read what the task's read, grep and glob read; before a chat's or plan's workspace, the snapshots,
	// and nothing once it has one. It still gets MCP servers and decide().
	const scope: ScriptScope = repoTask ? { repo: 'task', mcp: true } : { repo: !workspace && !incognito, mcp: true };
	const scripts = agentSettingsNow().codeMode && hasScriptTools(id, scope);
	if (scripts) useRunScript(id, scope);
	const connectors = connectorsFor(id);
	const scriptHint = scripts ? `${SCRIPT_HINT} ${connectors.some((connector) => connector.kind === 'mcp' && connector.codeMode) ? `${SCRIPTED_MCP_HINT} ` : ''}` : '';
	const project = threadProjectFor(id);
	if (!incognito) useRemember(id, project, chat);
	if (!incognito) useTodos(id);
	if (!incognito) useAgentRuns(id);
	// Results past 50KB are cut where they join the conversation (src/flue/tool-result-cut.ts); this reads on.
	useTool(fullResultTool(id));
	const visual = agentSettingsNow().visualReplies;
	useAsk(id);
	// An incognito chat keeps nothing, so it is not offered image generation.
	const drawing = imagesAvailable() && !incognito;
	if (drawing) useGenerateImage(id);
	if (visual !== 'off' && !incognito) {
		useShow(id);
		useRenderHtml(id);
	}
	// With a sandbox the files are in ../project-files too; the tool still reads PDFs and office documents as text.
	if (project) useProjectFiles(id);
	if (!incognito) useReadAttachment(id);
	if (connectors.length) useConnectorTools(id, connectors);
	const sealed = sealedSecretsFor(id);
	if (sealed.length) useHttpRequest(id);
	// The runtime finds a repository's .agents/skills itself only in a chat's, plan's or review's sandbox; a repository task's are mounted here.
	if (!incognito) useSkills(id, workspace && !repoTask);
	if (!incognito) useLatestInput(id);
	const browsing = !incognito && sharedBrowserAvailable();
	const places: BrowserPlace[] = [...(browsing ? (['panel'] as const) : []), ...(sandboxed ? (['sandbox'] as const) : [])];
	if (places.length) useBrowserSubagent(id, places);
	if (sandboxed) useComputerSubagent(id);
	// Web search; one that cannot be reached leaves its tools out rather than failing the reply.
	// Connectors' servers are not connected here: connector_tools and run_script reach the ones that are on, as they run.
	for (const server of mcpServersFor(id)) {
		if (!directServer(server, scripts)) continue;
		useMcpConnection({
			name: server.name,
			url: server.url,
			...(server.auth ? { auth: server.auth } : {}),
			...(server.tools.length ? { tools: server.tools } : {}),
			optional: true,
		});
	}
	if (!incognito) {
		// What the checks at a reply's end know of the task is read from its row now, ahead of a reply the runtime resumes
		// after a restart (which runs no start hooks), so a command's result can tell it how long it has run.
		void loadGate(id);
		// A compaction the last reply's end let pass: the request and todo list go word for word after the message that
		// starts this reply, before the model's first call. A user's message that starts the reply is the request itself,
		// already there word for word, so only the list goes with it; one that joins a running reply is not, so the request
		// goes too. Nothing is read from the database unless a compaction happened.
		const delivery = useDelivery();
		useAgentStart(async ({ append }) => {
			const pinned = await takePinned(id, { request: !(delivery.kind === 'user' && isRequest(id, delivery.body)) });
			if (pinned) append({ kind: 'signal', type: 'reminder', body: pinned });
		});
		// Every finished response leaves a checkpoint, so the task can be viewed after its machine stops.
		// Only a running machine: a task stopped or deleted mid-response is never started again for this.
		// The reply is also checked for whether it waits on the user, so the task can say so.
		useAgentFinish(async ({ response, append, signal }) => {
			// A stopped reply leaves no job of its own, nor a check of the repository, running.
			if (signal.aborted) {
				void stopReplyJobs(id);
				void stopRepoCheck(id);
			}
			// The checks read what they know of the task from its row before any of them runs.
			await loadGate(id);
			// After a compaction the request and todo list go word for word with whatever sends the reply back, ahead of it.
			// Never on their own: a reply sent back for them alone would pay a model call over the conversation to end again.
			// What the agent did after each earlier send-back is read from the calls it has made since.
			settleSendBacks(id, response.toolCalls);
			const sendBack = async (name: GateName, body: string) => {
				noteSendBack(id, name, response.toolCalls.length, body);
				const pinned = await takePinned(id);
				if (pinned) append({ kind: 'signal', type: 'reminder', body: pinned });
				append({ kind: 'signal', type: 'reminder', body });
			};
			// A todo list this reply wrote but left with steps open is brought up to date first; the reply then ends as usual.
			const reminder = signal.aborted ? null : await todoReminder(id, response.toolCalls);
			if (reminder) {
				await sendBack('todo', reminder);
				return;
			}
			// A reply that ends by announcing a step it never took is sent back to take it, once.
			const stalled = signal.aborted ? null : stallReminder(id, response.toolCalls);
			if (stalled) {
				await sendBack('stall', stalled);
				return;
			}
			// A job this reply started that still runs, or that ended with its result unread, sends it back: once a job each way.
			// Before the review, so the review reads the change as the job's result left it.
			const jobs = signal.aborted ? null : await jobsGate(id, response.toolCalls, { signal });
			if (jobs) {
				await sendBack('jobs', jobs);
				return;
			}
			// A reply that changed files waits for the repository's check of its last change, and a failure sends it back to fix
			// what broke or say it was there before: once a failure, twice a reply at most. Nothing at all with no check command.
			const broken = signal.aborted ? null : await checkGate(id, response.toolCalls, { signal });
			if (broken) {
				await sendBack('check', broken);
				return;
			}
			// A change is read once more against the request alone, and points it missed are sent back to check; a chat's, in the repositories it changed,
			// or, when its work left no diff, by the agent itself against what it made.
			// A task that started its workspace during this reply has one now, though this render began without it.
			const missed = (workspace || hasWorkspace(id)) && !planning && !review && !signal.aborted ? await finishReview(id, response.toolCalls, signal) : null;
			if (missed) {
				await sendBack('review', missed);
				return;
			}
			// A reply that ends with requested work left undone, and not for something only the user can give, is sent back to do it:
			// a few rounds at most, each after the first only when the last changed something. Each round lets the review read the new change.
			const undone = !planning && !review && !signal.aborted ? await completionGate(id, response.toolCalls, { chat, workspace: workspace || hasWorkspace(id), signal }) : null;
			if (undone) {
				await sendBack('completion', undone);
				return;
			}
			// The checkpoint lists and diffs the whole sandbox, so the reply ends without waiting for it.
			queueCheckpoint(id);
			// What the reply leaves (a question for you, work done) is judged by the decision model, which takes seconds:
			// the reply settles first, so its page shows it finished as soon as it is. Replies that end together are judged once, by the last.
			if (followingUp.has(id)) return;
			followingUp.add(id);
			whenIdle(id, () => {
				followingUp.delete(id);
				void followUp(id);
			});
		});
	}
	if (incognito) {
		// An incognito reply keeps only its usage and timing: no trace, no checkpoint, no review — nothing is saved.
		useResponseStart(() => ({ startedAt: Date.now() }));
		useResponseFinish(({ response, metadata }) => {
			const completedAt = Date.now();
			const startedAt = metadata.startedAt;
			return {
				usage: toUsage(response.usage),
				billing: onPlan(model) ? 'plan' : 'api',
				...(typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt <= completedAt ? { completedAt, durationMs: completedAt - startedAt } : {}),
			};
		});
	} else {
		// The message that starts the reply, which tells whether its sandbox is worth starting ahead of the agent.
		const opening = useDelivery();
		// These response hooks run at the true start/end, across all model and tool calls.
		// The persisted start survives resumed responses; usage totals are still counted per model call.
		useResponseStart(() => {
			startReply(id);
			startTrace(id);
			startTodoReply(id);
			startStallCheck(id);
			startFinishReview(id);
			startCompletionGate(id);
			startJobsGate(id);
			startCheckGate(id);
			startSendBacks(id);
			startReplyClock(id);
			// A repository task that goes on to change code has its sandbox start now, behind the agent's first reads; a message
			// the decision model reads as a question starts none (`prewarm-intent.ts`).
			if (!workspace && !hasWorkspace(id)) void prewarmFor(id, opening.kind === 'user' ? opening.body : null);
			// A repository task that has its workspace reads and works in its machine, which may have stopped since its last reply:
			// it starts now, behind the first model call, as it did when the runtime read the repository's instructions from it.
			else if (repoTask) void machineFor(id).catch((error: unknown) => logProblem('warn', 'The sandbox did not start ahead of the agent', error, id));
			return { startedAt: Date.now() };
		});
		useResponseFinish(({ response, metadata }) => {
			const completedAt = Date.now();
			const startedAt = metadata.startedAt;
			// The runtime's usage covers this conversation only; the reply's subagents are billed too.
			const reply = finishReply(id);
			// Its trace is saved behind the reply; the thread asks for it only when opened.
			const trace = finishTrace(id);
			if (trace) void saveTrace(trace).catch((error: unknown) => logProblem('warn', 'Trace not kept', error, id));
			return {
				...(trace ? { traceId: trace.id } : {}),
				usage: reply ? replyTotal(reply) : toUsage(response.usage),
				...(reply ? { usageParts: { main: reply.main, subagents: reply.subagents }, ...replyFacts(reply) } : { plan: planOf(model) }),
				// With the reply's tool calls by model (`tools`), what a benchmark's tool mix is read from.
				toolProfile: profile,
				// Which checks sent the reply back, and whether the agent then changed or ran anything (`npm run gates:report`).
				sendBacks: sendBacksOf(id),
				billing: reply?.billing ?? (onPlan(model) ? 'plan' : 'api'),
				...(typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt <= completedAt ? { completedAt, durationMs: completedAt - startedAt } : {}),
			};
		});
	}
	if (incognito) {
		return `${INCOGNITO_PROMPT} ${connectorHint(connectors)}${sealedHint(sealed)}`;
	}

	if (chat) {
		const prompt = workspace ? prompts.chatWorkspace : CHAT_PROMPT;
		return `${planning ? `${prompt} ${PLAN_PROMPT}` : prompt} ${browsing ? `${BROWSER_HINT} ` : ''}${workspace ? `${COMPUTER_HINT} ` : ''}${scriptHint}${TODO_HINT} ${REQUIREMENTS_HINT} ${WHILE_WORKING_HINT} ${visualHint(visual)} ${drawing ? `${IMAGE_HINT} ` : ''}${visual !== 'off' ? `${APP_HINT} ` : ''}${skillHint(id, workspace)} ${workspace && runsOnHost(id) ? hostHint() : ''}${connectorHint(connectors)}${sealedHint(sealed)}${attachmentHint(workspace, Boolean(project))}${projectPrompt(project, workspace, true)}`;
	}
	const prompt = repoTask ? prompts.task : workspace ? prompts.workspace : READ_ONLY_PROMPT;
	// The repository's instructions at the commit the task started from, the same before and after its sandbox starts;
	// a plan's or review's sandbox has the runtime read them from its files.
	const instructions = workspace && !repoTask ? '' : repoInstructionsPrompt(repoInstructionsFor(id));
	return `${planning ? `${prompt} ${PLAN_PROMPT}` : prompt} ${review ? `${reviewPrompt(review)} ` : ''}${browsing ? `${BROWSER_HINT} ` : ''}${sandboxed ? `${COMPUTER_HINT} ` : ''}${scriptHint}${MENTION_HINT} ${TODO_HINT} ${REQUIREMENTS_HINT} ${WHILE_WORKING_HINT} ${visualHint(visual)} ${drawing ? `${IMAGE_HINT} ` : ''}${REMEMBER_HINT} ${skillHint(id, sandboxed)} ${sandboxed && runsOnHost(id) ? hostHint() : ''}${connectorHint(connectors)}${sealedHint(sealed)}${attachmentHint(sandboxed, Boolean(project))}${instructions}${memoryPrompt(memoryFor(id))}${projectPrompt(project, sandboxed)}`;
}

/** A turn may run up to 4 hours before it is stopped, or `ANTON_REPLY_TIMEOUT_HOURS`; Flue's default of 1 hour cuts off long features mid-work. */
Coder.durability = { timeoutMs: config.replyTimeoutMs };
