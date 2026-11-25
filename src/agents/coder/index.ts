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
import { agentCompaction } from '../../services/context/context-usage.ts';
import { fullResultTool } from '../../services/context/tool-results.ts';
import { liveMachine, machineFor } from '../../services/sandbox/workspace.ts';
import { prewarmFor } from '../../services/sandbox/prewarm-intent.ts';
import { sharedBrowserAvailable } from '../../services/browser/live-browser.ts';
import { isIncognitoId } from '../../core/incognito.ts';
import { logProblem } from '../../core/log.ts';
import { recordLatestInput } from '../../services/tasks/latest-input.ts';
import { noteDelivery } from '../../services/tasks/joins.ts';
import { checkReply, stallReminder, startStallCheck } from '../../services/replies/reply-check.ts';
import { startAwaitingRun } from '../../services/replies/asks.ts';
import { finishReview, isRequest, noteRequest, startFinishReview } from '../../services/replies/finish-review.ts';
import { openedThisReply, pushGate, startPushGate } from '../../services/replies/push-gate.ts';
import { prePushReview, startPrePushReview } from '../../services/replies/pre-push-review.ts';
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
import { useSetRepo } from './tools/repo.ts';
import { applyRepoMove, dropRepoMove, pendingRepoMove } from '../../services/projects/thread-repos.ts';
import { useProjectFiles, useReadAttachment, useSkills } from './tools/files.ts';
import { useConnectorTools, useHttpRequest } from './tools/connectors.ts';
import { useProposePlan } from './tools/plan.ts';
// Registers the model providers before this agent resolves a model.
import '../providers.ts';

/**
 * Records each message the agent is given; the runtime emits no event for them. Only the message that starts a reply
 * is its request: one sent while the reply runs joins it and fires `useAgentStart` again but not `useResponseStart`.
 */
function useLatestInput(id: string) {
	const delivery = useDelivery();
	useResponseStart(() => {
		if (delivery.kind === 'user') noteRequest(id, delivery.body);
	});
	useAgentStart(() => {
		if (delivery.kind !== 'user') return;
		// The reply starts without waiting on the database, which can be busy for seconds.
		inBackground(id, Promise.all([noteDelivery(id, delivery.body), recordLatestInput(id, delivery.body)]));
	});
}

/** Each task's bookkeeping writes still in hand; `followUp` waits for them. */
const bookkeeping = new Map<string, Promise<unknown>>();

function inBackground(id: string, work: Promise<unknown>): void {
	const next = Promise.all([bookkeeping.get(id), work]).catch(() => undefined);
	bookkeeping.set(id, next);
	void next.then(() => {
		if (bookkeeping.get(id) === next) bookkeeping.delete(id);
	});
}

/** The next checkpoint write waits for this one, so two never read and write the same checkpoint at once. */
const checkpoints = new Map<string, Promise<void>>();

function queueCheckpoint(id: string): void {
	const next = (checkpoints.get(id) ?? Promise.resolve()).then(async () => {
		try {
			const machine = await liveMachine(id);
			if (machine) {
				await saveCheckpoint(id, machine);
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

const followingUp = new Set<string>();

async function followUp(id: string): Promise<void> {
	// The message's write clears what the task was asking; what this reply asks is written after it.
	await bookkeeping.get(id);
	const reply = await checkReply(id);
	await threadFinished(id, reply).catch((error: unknown) => logProblem('warn', 'Could not report the thread', error, id));
	// After it is judged done or not, so the row says Done rather than Replied.
	await replyNotification(id, reply);
	await replyNotice(id, reply);
}

/** A repository task reads a repo snapshot with no sandbox until its first command or change starts one. */
export function Coder({ id }: AgentProps) {
	const { model, reasoning } = agentModelFor(id);
	useModel(model, { thinkingLevel: reasoning, compaction: agentCompaction(model) });
	const profile = toolProfileFor(model, config.toolProfile);
	const prompts = PROMPTS[profile];
	const [started, setStarted] = usePersistentState('workspace', false);
	const workspace = started || hasWorkspace(id);
	const incognito = isIncognitoId(id);
	const chat = isChat(id) || incognito;
	const planning = isPlanning(id);
	const review = reviewTaskFor(id);
	// One system prompt and one tool list from the first model call to the last.
	const repoTask = !chat && !planning && !review;
	// A repository task gets its sandbox on first use, so its prompt and tools offer it from the start.
	const sandboxed = repoTask || workspace;
	watchRepoCheck(id, repoTask && !runsOnHost(id));
	if (repoTask) useTaskWorkspace(id, profile);
	else if (workspace) useWorkspace(id, chat, review, profile);
	else if (!incognito) {
		useRepoSnapshot(id, chat);
		useSnapshotExplorer(id, chat);
		if (!planning) useStartWorkspace(id, chat, () => setStarted(true));
	}
	if (planning) useProposePlan(id);
	// Code mode's repo tools read what the task's own tools read; for a chat or plan, the snapshots until it has a workspace.
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
	// A plan or review stays on the repository it reads.
	if (project && !planning && !review && !incognito) useSetRepo(id);
	const drawing = imagesAvailable() && !incognito;
	if (drawing) useGenerateImage(id);
	if (visual !== 'off' && !incognito) {
		useShow(id);
		useRenderHtml(id);
	}
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
	// An unreachable server leaves its tools out rather than failing the reply.
	// Connectors' servers are not connected here: connector_tools and run_script reach them as they run.
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
		// What the checks at a reply's end know is read now: a reply the runtime resumes after a restart runs no start hooks.
		void loadGate(id);
		// After a compaction the request and todo list go word for word after the message that starts this reply. A user's
		// message that starts it is the request itself, so only the list goes with it.
		const delivery = useDelivery();
		useAgentStart(async ({ append }) => {
			const pinned = await takePinned(id, { request: !(delivery.kind === 'user' && isRequest(id, delivery.body)) });
			if (pinned) append({ kind: 'signal', type: 'reminder', body: pinned });
		});
		// The checkpoint uses only a running machine: a task stopped or deleted mid-response is never started again for it.
		useAgentFinish(async ({ response, append, signal }) => {
			if (signal.aborted) {
				void stopReplyJobs(id);
				void stopRepoCheck(id);
			}
			// A reply that moves the thread ends there: its checks belong to the repository it leaves.
			if (pendingRepoMove(id)) {
				if (signal.aborted) dropRepoMove(id);
				else whenIdle(id, () => void applyRepoMove(id));
				return;
			}
			// The checks read what they know of the task from its row before any of them runs.
			await loadGate(id);
			// The pinned request and todo list only ride a send-back: alone they would pay a model call over the conversation.
			settleSendBacks(id, response.toolCalls);
			const sendBack = async (name: GateName, body: string) => {
				noteSendBack(id, name, response.toolCalls.length, body);
				const pinned = await takePinned(id);
				if (pinned) append({ kind: 'signal', type: 'reminder', body: pinned });
				append({ kind: 'signal', type: 'reminder', body });
			};
			const reminder = signal.aborted ? null : await todoReminder(id, response.toolCalls);
			if (reminder) {
				await sendBack('todo', reminder);
				return;
			}
			const stalled = signal.aborted ? null : stallReminder(id, response.toolCalls);
			if (stalled) {
				await sendBack('stall', stalled);
				return;
			}
			// Before the review, so the review reads the change as the job's result left it.
			const jobs = signal.aborted ? null : await jobsGate(id, response.toolCalls, { signal });
			if (jobs) {
				await sendBack('jobs', jobs);
				return;
			}
			const broken = signal.aborted ? null : await checkGate(id, response.toolCalls, { signal });
			if (broken) {
				await sendBack('check', broken);
				return;
			}
			// A task that started its workspace during this reply has one now, though this render began without it.
			const missed = (workspace || hasWorkspace(id)) && !planning && !review && !signal.aborted ? await finishReview(id, response.toolCalls, signal) : null;
			if (missed) {
				await sendBack('review', missed);
				return;
			}
			const undone = !planning && !review && !signal.aborted ? await completionGate(id, response.toolCalls, { chat, workspace: workspace || hasWorkspace(id), signal }) : null;
			if (undone) {
				await sendBack('completion', undone);
				return;
			}
			// Once the change is done, before its push: what it could break, read with fresh eyes.
			const bugs = (workspace || hasWorkspace(id)) && !planning && !review && !signal.aborted ? await prePushReview(id) : null;
			if (bugs) {
				await sendBack('bugs', bugs);
				return;
			}
			// Last, so the one push carries every fix the checks above asked for.
			const unpushed = signal.aborted ? null : await pushGate(id);
			if (unpushed) {
				await sendBack('push', unpushed);
				return;
			}
			// The checkpoint lists and diffs the whole sandbox, so the reply ends without waiting for it.
			queueCheckpoint(id);
			// What the reply leaves is judged by the decision model, which takes seconds, so the reply settles first.
			// Replies that end together are judged once, by the last.
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
		const opening = useDelivery();
		// These run once per reply, across all its model and tool calls; the persisted start survives a resumed reply.
		useResponseStart(() => {
			startReply(id);
			startTrace(id);
			startTodoReply(id);
			startStallCheck(id);
			startAwaitingRun(id);
			startFinishReview(id);
			startCompletionGate(id);
			startJobsGate(id);
			startCheckGate(id);
			startPushGate(id);
			startPrePushReview(id);
			startSendBacks(id);
			startReplyClock(id);
			if (!workspace && !hasWorkspace(id)) void prewarmFor(id, opening.kind === 'user' ? opening.body : null);
			// Its machine may have stopped since the last reply: start it now, behind the first model call.
			else if (repoTask) void machineFor(id).catch((error: unknown) => logProblem('warn', 'The sandbox did not start ahead of the agent', error, id));
			return { startedAt: Date.now() };
		});
		useResponseFinish(({ response, metadata }) => {
			const completedAt = Date.now();
			const startedAt = metadata.startedAt;
			// The runtime's usage covers this conversation only; the reply's subagents are billed too.
			const reply = finishReply(id);
			const trace = finishTrace(id);
			if (trace) void saveTrace(trace).catch((error: unknown) => logProblem('warn', 'Trace not kept', error, id));
			const pullRequest = openedThisReply(id);
			return {
				...(trace ? { traceId: trace.id } : {}),
				// The reply's pull request card: it is pushed after the agent's last word, so no tool call carries its link.
				...(pullRequest ? { pullRequest } : {}),
				usage: reply ? replyTotal(reply) : toUsage(response.usage),
				...(reply ? { usageParts: { main: reply.main, subagents: reply.subagents }, ...replyFacts(reply) } : { plan: planOf(model) }),
				// Read by scripts/tool-mix.ts.
				toolProfile: profile,
				// Read by scripts/gates-report.ts.
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
	// At the task's base commit; a plan's or review's sandbox has the runtime read them from its files.
	const instructions = workspace && !repoTask ? '' : repoInstructionsPrompt(repoInstructionsFor(id));
	return `${planning ? `${prompt} ${PLAN_PROMPT}` : prompt} ${review ? `${reviewPrompt(review)} ` : ''}${browsing ? `${BROWSER_HINT} ` : ''}${sandboxed ? `${COMPUTER_HINT} ` : ''}${scriptHint}${MENTION_HINT} ${TODO_HINT} ${REQUIREMENTS_HINT} ${WHILE_WORKING_HINT} ${visualHint(visual)} ${drawing ? `${IMAGE_HINT} ` : ''}${REMEMBER_HINT} ${skillHint(id, sandboxed)} ${sandboxed && runsOnHost(id) ? hostHint() : ''}${connectorHint(connectors)}${sealedHint(sealed)}${attachmentHint(sandboxed, Boolean(project))}${instructions}${memoryPrompt(memoryFor(id))}${projectPrompt(project, sandboxed)}`;
}

Coder.durability = { timeoutMs: config.replyTimeoutMs };
