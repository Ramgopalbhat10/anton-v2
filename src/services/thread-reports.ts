import { splitAttachments } from '../core/attachments.ts';
import type { Session } from '../core/types.ts';
import { getAutomation } from '../db/automations.ts';
import { getSessionRecord, listSessionRecords, updateSession } from '../db/sessions.ts';
import { sendToAgent } from './agent-runner.ts';
import { type ThreadState, threadState } from '../core/thread-state.ts';
import { logProblem } from './log.ts';
import { finishesWork } from './reply-check.ts';
import { drainQueue, launched } from './spaces.ts';
import { getSession } from './sessions.ts';

/**
 * How threads tell their coordinator what changed. A thread that finishes a
 * reply, or whose pull request changes, is noted; notes from one project are
 * gathered for a short while and sent as one message, and only a change of
 * state is sent, so a thread that follows up on CI three times reports once
 * when it goes green. Working and queued are not news when the coordinator
 * started them; a thread you or a routine started is reported as it starts,
 * so the coordinator knows of it and its feed shows it at once.
 */
export const REPORT_DELAY_MS = 20_000;
/** The start of a reply kept for the card and the report. */
const MAX_REPLY = 4_000;

const pending = new Map<string, Set<string>>();
const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
/** Who started a thread, when the coordinator did not: you, with the brief you gave it, or a routine. */
export type Starter = { by: 'you'; brief: string } | { by: 'routine'; routine: string };
/** Threads the coordinator did not start, by who did: news to the coordinator. */
const starts = new Map<string, Starter>();
/** A thread the coordinator did not start is reported a moment after it starts (threads started together go as one), so the feed shows it as it begins. */
export const START_REPORT_DELAY_MS = 1_000;

const QUIET: ThreadState[] = ['working', 'queued'];

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const body = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const prNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1];
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text).trim();

/** One thread's line in a report, as the coordinator reads it and the feed shows it; `started` says who just started it, when the coordinator did not. */
export function reportLine(thread: Session, state: ThreadState, started?: Starter): string {
	const pr = thread.prUrl && thread.pullRequest ? ` pr="#${prNumber(thread.prUrl) ?? '?'} ${thread.pullRequest.state}${thread.pullRequest.checks ? `, checks ${thread.pullRequest.checks}` : ''}"` : '';
	const asks = state === 'waiting' && thread.asking ? ` asks="${attr(thread.asking)}"` : '';
	const said = (thread.lastReply ?? '').slice(0, 600).trim();
	const failed = thread.status === 'error' && thread.errorMessage ? `Failed: ${thread.errorMessage}` : '';
	const why = started?.by === 'routine' ? `Started by the routine that runs ${started.routine}.` : started?.by === 'you' ? clip(splitAttachments(started.brief).text, 600) : '';
	const text = failed || said || why;
	const by = started ? ` started="${started.by}"` : '';
	const open = `  <thread id="${thread.id.slice(0, 8)}" title="${attr(thread.title)}" state="${state}"${by}${pr}${asks}`;
	return text ? `${open}>${body(text)}</thread>` : `${open}/>`;
}

/** The message the coordinator gets; the feed shows it as a quiet row. */
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
		const state = thread.threadState;
		if (started) {
			// Its state is not kept: it has not replied yet, and its first reply is news whatever state it leaves.
			lines.push(reportLine(thread, state ?? 'queued', started));
			continue;
		}
		if (!state || state === record.reportedState) continue;
		await updateSession(id, { reportedState: state });
		if (!QUIET.includes(state)) lines.push(reportLine(thread, state));
	}
	if (lines.length === 0) return;
	await sendToAgent(spaceId, reportMessage(lines), 'coordinator').catch((error: unknown) => logProblem('warn', 'Could not report threads to the coordinator', error));
}

/** Notes that a task may have changed state: done once its pull request is merged or closed, and for a project's thread, news the coordinator hears of once the batch goes out. */
export async function threadChanged(id: string, delayMs = REPORT_DELAY_MS): Promise<void> {
	const record = await getSessionRecord(id);
	if (!record) return;
	// A merged or closed pull request is the task's last step.
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

/** You or a routine started the thread, not the coordinator: it hears of it in a moment, with who did, and the feed shows it. */
export async function threadStarted(id: string, starter: Starter): Promise<void> {
	starts.set(id, starter);
	await threadChanged(id, START_REPORT_DELAY_MS);
}

/** Sends every waiting report now (tests, and shutting down). */
export async function flushReports(): Promise<void> {
	for (const [spaceId, { timer }] of [...timers]) {
		clearTimeout(timer);
		await flush(spaceId);
	}
}

/**
 * At the end of any task's reply: keeps what it said and marks it done when
 * the reply finished the work; a project's thread also frees its slot for a
 * queued thread and is noted for the coordinator.
 */
export async function threadFinished(id: string, reply: string | null): Promise<void> {
	const record = await getSessionRecord(id);
	if (!record) return;
	if (record.spaceId) launched(id);
	if (reply) await updateSession(id, { lastReply: reply.slice(0, MAX_REPLY) });
	if (reply) await closeIfFinished(id, reply).catch((error: unknown) => logProblem('warn', 'Could not judge whether the task is done', error, id));
	if (!record.spaceId) return;
	await threadChanged(id);
	await drainQueue(record.spaceId, id);
}

/**
 * A task whose reply delivered what it was asked is done: resolved, as a
 * person would mark it, and reopened by the next message it is given. Only
 * one that would otherwise sit idle: a task that asks you something, waits
 * in the queue or has a pull request open stays as it is (a pull request
 * resolves its task once merged or closed). A scheduled routine's run is done
 * once it replies without asking you anything, since delivering is all a run does,
 * even when its reply offers more; any other task is judged by the decision
 * model, so an answer or an offer of a next step leaves it open.
 */
async function closeIfFinished(id: string, reply: string): Promise<void> {
	const task = await getSession(id);
	// This runs as the reply ends, before it settles, so the task still counts as working: it is judged as it is about to stand.
	if (threadState({ ...task, working: false }) !== 'idle' || task.prUrl) return;
	if ((await scheduledRun(task)) || (await finishesWork(id, task.lastInput, reply))) await updateSession(id, { resolvedAt: new Date().toISOString() });
}

/** A run of a scheduled routine; a labeled issue's task is there to open a pull request, so it is judged as any other. */
async function scheduledRun(task: Session): Promise<boolean> {
	return task.automationId ? (await getAutomation(task.automationId))?.kind === 'schedule' : false;
}

/** How long an idle task stays open before it resolves itself. */
export const IDLE_RESOLVE_MS = 7 * 24 * 60 * 60_000;

/** Resolves tasks idle for a week; their branches and files stay. Run by the headless poll. */
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
