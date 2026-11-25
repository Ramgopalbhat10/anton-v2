import { splitAttachments } from '../../core/attachments.ts';
import type { Session } from '../../core/types.ts';
import { getAutomation } from '../../db/automations.ts';
import { getSessionRecord, listSessionRecords, updateSession } from '../../db/sessions.ts';
import { sendToAgent } from '../tasks/agent-runner.ts';
import { type ThreadState, threadState } from '../../core/thread-state.ts';
import { isWorking } from '../tasks/activity.ts';
import { logProblem } from '../../core/log.ts';
import { finishesWork } from '../replies/reply-check.ts';
import { drainQueue, launched } from './spaces.ts';
import { getSession } from '../tasks/sessions.ts';

/** Notes are batched per project. A thread is reported when its state changes, or when a reply of its pushed new commits, so a round of review fixes is news. */
export const REPORT_DELAY_MS = 20_000;
const MAX_REPLY = 4_000;

const pending = new Map<string, Set<string>>();
const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
export type Starter = { by: 'you'; brief: string } | { by: 'routine'; routine: string };
const starts = new Map<string, Starter>();
/** Threads started together go as one. */
export const START_REPORT_DELAY_MS = 1_000;

const QUIET: ThreadState[] = ['working', 'queued'];
/** The state a reply ended in: the automatic review or the next message can have the thread working again before its batch goes. */
const ended = new Map<string, ThreadState>();
/** The pushed head each thread's last report went out with. Unknown after a restart, so the first round then reports only a change of state. */
const reportedHead = new Map<string, string | null>();

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const body = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const prNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1];
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text).trim();

export function reportLine(thread: Session, state: ThreadState, started?: Starter): string {
	const pr = thread.prUrl && thread.pullRequest ? ` pr="#${prNumber(thread.prUrl) ?? '?'} ${thread.pullRequest.state}${thread.pullRequest.checks ? `, checks ${thread.pullRequest.checks}` : ''}"` : '';
	const asks = state === 'waiting' && thread.asking ? ` asks="${attr(thread.asking)}"` : '';
	const said = (thread.lastReply ?? '').slice(0, 600).trim();
	const failed = thread.status === 'error' && thread.errorMessage ? `Failed: ${thread.errorMessage}` : thread.stoppedAt && state === 'waiting' ? 'The user stopped this reply before it finished.' : '';
	const why = started?.by === 'routine' ? `Started by the routine that runs ${started.routine}.` : started?.by === 'you' ? clip(splitAttachments(started.brief).text, 600) : '';
	const text = failed || said || why;
	const by = started ? ` started="${started.by}"` : '';
	const open = `  <thread id="${thread.id.slice(0, 8)}" title="${attr(thread.title)}" state="${state}"${by}${pr}${asks}`;
	return text ? `${open}>${body(text)}</thread>` : `${open}/>`;
}

export function reportMessage(lines: string[]): string {
	return `<thread-reports>\n${lines.join('\n')}\n</thread-reports>`;
}

async function flush(spaceId: string): Promise<void> {
	timers.delete(spaceId);
	const ids = [...(pending.get(spaceId) ?? [])];
	pending.delete(spaceId);
	const lines: string[] = [];
	for (const id of ids) {
		const started = starts.get(id);
		starts.delete(id);
		const record = await getSessionRecord(id);
		if (!record || record.spaceId !== spaceId) continue;
		const thread = await getSession(id);
		if (started) {
			// Its state is not kept: it has not replied yet, and its first reply is news whatever state it leaves.
			lines.push(reportLine(thread, thread.threadState ?? 'queued', started));
			continue;
		}
		const endedIn = ended.get(id);
		ended.delete(id);
		const state = thread.threadState === 'working' && endedIn ? endedIn : thread.threadState;
		if (!state) continue;
		// A review round that pushed commits is news though the state stays Ready for review.
		const head = record.pushedSha ?? null;
		const pushed = endedIn !== undefined && head !== null && reportedHead.has(id) && reportedHead.get(id) !== head;
		reportedHead.set(id, head);
		if (state === record.reportedState && !pushed) continue;
		if (state !== record.reportedState) await updateSession(id, { reportedState: state });
		if (!QUIET.includes(state)) lines.push(reportLine(thread, state));
	}
	if (lines.length === 0) return;
	await sendToAgent(spaceId, reportMessage(lines), 'coordinator').catch((error: unknown) => logProblem('warn', 'Could not report threads to the coordinator', error));
}

export async function threadChanged(id: string, delayMs = REPORT_DELAY_MS): Promise<void> {
	const record = await getSessionRecord(id);
	if (!record) return;
	const pr = record.prUrl ? record.pullRequest : null;
	if (!record.resolvedAt && (pr?.state === 'merged' || pr?.state === 'closed')) await updateSession(id, { resolvedAt: new Date().toISOString() });
	if (!record.spaceId) return;
	const spaceId = record.spaceId;
	pending.set(spaceId, (pending.get(spaceId) ?? new Set()).add(id));
	// A batch already waiting goes out with this note, sooner when this one is due first.
	const at = Date.now() + delayMs;
	const waiting = timers.get(spaceId);
	if (waiting && waiting.at <= at) return;
	if (waiting) clearTimeout(waiting.timer);
	const timer = setTimeout(() => void flush(spaceId).catch((error: unknown) => logProblem('warn', 'Thread report failed', error)), delayMs);
	timer.unref?.();
	timers.set(spaceId, { at, timer });
}

export async function threadStarted(id: string, starter: Starter): Promise<void> {
	starts.set(id, starter);
	await threadChanged(id, START_REPORT_DELAY_MS);
}

export async function flushReports(): Promise<void> {
	for (const [spaceId, { timer }] of [...timers]) {
		clearTimeout(timer);
		await flush(spaceId);
	}
}

export async function threadFinished(id: string, reply: string | null): Promise<void> {
	const record = await getSessionRecord(id);
	if (!record) return;
	if (record.spaceId) launched(id);
	if (reply) await updateSession(id, { lastReply: reply.slice(0, MAX_REPLY) });
	if (reply) await closeIfFinished(id, reply).catch((error: unknown) => logProblem('warn', 'Could not judge whether the task is done', error, id));
	if (!record.spaceId) return;
	ended.set(id, threadState({ ...(await getSession(id)), working: false }));
	await threadChanged(id);
	await drainQueue(record.spaceId, id);
}

type RunEvent = { type: string; instanceId?: string; agentName?: string; outcome?: string; error?: unknown };

const MAX_ERROR = 1_000;
const errorText = (error: unknown) =>
	error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : typeof error === 'string' ? error : null;
/** One task's failure writes in the order their events came, so a retry's start never lands before the failure it clears. */
const failureWrites = new Map<string, Promise<void>>();

/**
 * A reply that fails, even one whose agent never started, leaves its task Failed (Needs you), not Done; the next reply
 * that runs clears it. Such a reply never reaches the end-of-reply hook, so its project slot is freed and the queue drained here.
 */
export function noteReplyOutcome(event: RunEvent): void {
	const id = event.instanceId;
	if (!id || (event.agentName && !/^coder$/i.test(event.agentName))) return;
	const failed = event.type === 'submission_settled' && event.outcome === 'failed';
	if (!failed && event.type !== 'submission_running') return;
	const next = (failureWrites.get(id) ?? Promise.resolve())
		.then(() => (failed ? threadFailed(id, errorText(event.error) ?? 'The reply stopped with an error.') : replyRunning(id)))
		.catch((error: unknown) => logProblem('warn', 'Could not record the reply outcome', error, id));
	failureWrites.set(id, next);
	void next.then(() => {
		if (failureWrites.get(id) === next) failureWrites.delete(id);
	});
}

async function replyRunning(id: string): Promise<void> {
	const record = await getSessionRecord(id);
	if (record?.failed) await updateSession(id, { failed: false, errorMessage: null });
	if (record?.stoppedAt) await updateSession(id, { stoppedAt: null });
}

export async function threadFailed(id: string, message: string): Promise<void> {
	const record = await getSessionRecord(id);
	if (!record) return;
	await updateSession(id, { failed: true, errorMessage: clip(message, MAX_ERROR) });
	if (!record.spaceId) return;
	launched(id);
	await threadChanged(id);
	await drainQueue(record.spaceId);
}

/** Only one that would sit idle; a scheduled run is done once it replies without asking; any other is judged by the decision model. */
async function closeIfFinished(id: string, reply: string): Promise<void> {
	const task = await getSession(id);
	// This runs once the reply has settled; a task working again was sent a message meanwhile, which reopens it anyway.
	if (threadState(task) !== 'idle' || task.prUrl) return;
	const done = (await scheduledRun(task)) || (await finishesWork(id, task.lastInput, reply));
	if (done && !isWorking(id)) await updateSession(id, { resolvedAt: new Date().toISOString() });
}

/** A labeled issue's task is there to open a pull request, so it is judged as any other. */
async function scheduledRun(task: Session): Promise<boolean> {
	return task.automationId ? (await getAutomation(task.automationId))?.kind === 'schedule' : false;
}

export const IDLE_RESOLVE_MS = 7 * 24 * 60 * 60_000;

export async function resolveIdleThreads(now = Date.now()): Promise<number> {
	let resolved = 0;
	for (const record of await listSessionRecords()) {
		if (record.resolvedAt || record.brief) continue;
		const thread = await getSession(record.id);
		const at = new Date(thread.checkpointAt ?? thread.lastInputAt ?? thread.createdAt).getTime();
		if (thread.threadState !== 'idle' || now - at < IDLE_RESOLVE_MS) continue;
		await updateSession(record.id, { resolvedAt: new Date(now).toISOString() });
		resolved += 1;
	}
	return resolved;
}
