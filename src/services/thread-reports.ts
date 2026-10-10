import type { Session } from '../core/types.ts';
import { getSessionRecord, listSessionRecords, updateSession } from '../db/sessions.ts';
import { sendToAgent } from './agent-runner.ts';
import type { ThreadState } from '../core/thread-state.ts';
import { logProblem } from './log.ts';
import { drainQueue, launched } from './spaces.ts';
import { getSession } from './sessions.ts';

/**
 * How threads tell their coordinator what changed. A thread that finishes a
 * reply, or whose pull request changes, is noted; notes from one project are
 * gathered for a short while and sent as one message, and only a change of
 * state is sent, so a thread that follows up on CI three times reports once
 * when it goes green. Working and queued are not news: the coordinator
 * started them.
 */
export const REPORT_DELAY_MS = 20_000;
/** The start of a reply kept for the card and the report. */
const MAX_REPLY = 4_000;

const pending = new Map<string, Set<string>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const QUIET: ThreadState[] = ['working', 'queued'];

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const body = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const prNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1];

/** One thread's line in a report, as the coordinator reads it and the feed shows it. */
export function reportLine(thread: Session, state: ThreadState): string {
	const pr = thread.prUrl && thread.pullRequest ? ` pr="#${prNumber(thread.prUrl) ?? '?'} ${thread.pullRequest.state}${thread.pullRequest.checks ? `, checks ${thread.pullRequest.checks}` : ''}"` : '';
	const asks = state === 'waiting' && thread.asking ? ` asks="${attr(thread.asking)}"` : '';
	const said = (thread.lastReply ?? '').slice(0, 600).trim();
	const failed = thread.status === 'error' && thread.errorMessage ? `Failed: ${thread.errorMessage}` : '';
	const text = failed || said;
	const open = `  <thread id="${thread.id.slice(0, 8)}" title="${attr(thread.title)}" state="${state}"${pr}${asks}`;
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
		const record = await getSessionRecord(id);
		if (!record || record.spaceId !== spaceId) continue;
		const thread = await getSession(id);
		const state = thread.threadState;
		if (!state || state === record.reportedState) continue;
		await updateSession(id, { reportedState: state });
		if (!QUIET.includes(state)) lines.push(reportLine(thread, state));
	}
	if (lines.length === 0) return;
	await sendToAgent(spaceId, reportMessage(lines), 'coordinator').catch((error: unknown) => logProblem('warn', 'Could not report threads to the coordinator', error));
}

/** Notes that a thread may have changed state; the coordinator hears of it once the batch goes out. */
export async function threadChanged(id: string, delayMs = REPORT_DELAY_MS): Promise<void> {
	const record = await getSessionRecord(id);
	if (!record?.spaceId) return;
	const spaceId = record.spaceId;
	// A merged or closed pull request is the thread's last step.
	const pr = record.prUrl ? record.pullRequest : null;
	if (!record.resolvedAt && (pr?.state === 'merged' || pr?.state === 'closed')) await updateSession(id, { resolvedAt: new Date().toISOString() });
	pending.set(spaceId, (pending.get(spaceId) ?? new Set()).add(id));
	if (!timers.has(spaceId)) {
		timers.set(
			spaceId,
			setTimeout(() => void flush(spaceId).catch((error: unknown) => logProblem('warn', 'Thread report failed', error)), delayMs),
		);
		timers.get(spaceId)?.unref?.();
	}
}

/** Sends every waiting report now (tests, and shutting down). */
export async function flushReports(): Promise<void> {
	for (const [spaceId, timer] of [...timers]) {
		clearTimeout(timer);
		await flush(spaceId);
	}
}

/**
 * At the end of a thread's reply: keeps what it said, frees its slot for a
 * queued thread, and notes it for the coordinator.
 */
export async function threadFinished(id: string, reply: string | null): Promise<void> {
	const record = await getSessionRecord(id);
	if (!record?.spaceId) return;
	launched(id);
	if (reply) await updateSession(id, { lastReply: reply.slice(0, MAX_REPLY) });
	await threadChanged(id);
	await drainQueue(record.spaceId);
}

/** How long an idle thread stays open before it resolves itself. */
export const IDLE_RESOLVE_MS = 7 * 24 * 60 * 60_000;

/** Resolves threads idle for a week; their tasks and branches stay. Run by the headless poll. */
export async function resolveIdleThreads(now = Date.now()): Promise<number> {
	let resolved = 0;
	for (const record of await listSessionRecords()) {
		if (!record.spaceId || record.resolvedAt || record.brief) continue;
		const thread = await getSession(record.id);
		const at = new Date(thread.checkpointAt ?? thread.lastInputAt ?? thread.createdAt).getTime();
		if (thread.threadState !== 'idle' || now - at < IDLE_RESOLVE_MS) continue;
		await updateSession(record.id, { resolvedAt: new Date(now).toISOString() });
		resolved += 1;
	}
	return resolved;
}
