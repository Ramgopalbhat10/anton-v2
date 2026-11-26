import type { SessionRecord } from '../../core/types.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { isWorking } from './activity.ts';
import { hasRunningJob } from '../sandbox/background-jobs.ts';
import { userHasControl } from '../browser/computer.ts';
import { logProblem } from '../../core/log.ts';
import { notifySandboxStopped } from '../notify/notifications.ts';
import { sandboxSettings } from '../sandbox/sandbox-settings.ts';
import { runningKeys, stopSession } from './sessions.ts';
import { askedHere, isStarting } from '../sandbox/workspace.ts';

/*
 * The provider's idle timeout counts every command as use, and an open Files or Changes panel reads the machine every few
 * seconds. Here a task is in use only while its agent works, a job it started runs, a terminal is open or you control its computer.
 */

const quietSince = new Map<string, number>();
const terminals = new Map<string, number>();

const SWEEP_MS = 60_000;

export function noteActive(id: string): void {
	quietSince.delete(id);
}

export function holdTerminal(id: string): () => void {
	terminals.set(id, (terminals.get(id) ?? 0) + 1);
	noteActive(id);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = (terminals.get(id) ?? 1) - 1;
		if (left > 0) terminals.set(id, left);
		else terminals.delete(id);
		noteActive(id);
	};
}

/** A background job counts until it ends or its time is up, so a job never holds the sandbox for good. */
const inUse = (id: string) => isWorking(id) || isStarting(id) || terminals.has(id) || userHasControl(id) || hasRunningJob(id);

/** Its pull request merged or closed and nobody has written since (a new message clears `resolvedAt`). */
const done = (record: SessionRecord) => record.resolvedAt !== null && (record.pullRequest?.state === 'merged' || record.pullRequest?.state === 'closed');

/**
 * The clock is in memory, so a restart (each deploy) would start every wait over. A machine already up when this server
 * started counts as quiet since its task last did anything: its last checkpoint is written as each reply ends.
 */
function quietFrom(record: SessionRecord, now: number): number {
	if (askedHere(record.id)) return now;
	const seen = [record.checkpointAt, record.lastInputAt].filter((at): at is string => at !== null);
	const last = Math.max(...(seen.length ? seen : [record.createdAt]).map(Date.parse));
	return Number.isFinite(last) ? Math.min(last, now) : now;
}

/** Only this Anton's tasks, never another install's sandboxes. */
export async function stopIdleSandboxes(now = Date.now()): Promise<string[]> {
	const [running, settings] = await Promise.all([runningKeys(), sandboxSettings()]);
	for (const id of quietSince.keys()) if (!running.has(id)) quietSince.delete(id);
	const idleMs = settings.idleMinutes * 60_000;
	const stopped: string[] = [];
	for (const id of running) {
		if (inUse(id)) {
			quietSince.delete(id);
			continue;
		}
		const record = await getSessionRecord(id);
		// A sandbox of another install sharing the provider is not this Anton's to stop.
		if (!record) continue;
		const since = quietSince.get(id) ?? quietFrom(record, now);
		quietSince.set(id, since);
		const finished = done(record);
		if (!finished && now - since < idleMs) continue;
		// A reply may have started meanwhile.
		if (inUse(id)) continue;
		quietSince.delete(id);
		await stopSession(id).then(
			() => {
				stopped.push(id);
				notifySandboxStopped(id, finished ? null : settings.idleMinutes);
			},
			(error: unknown) => logProblem('warn', 'Could not stop an idle sandbox', error, id),
		);
	}
	return stopped;
}

export function scheduleIdleStops(): void {
	let busy = false;
	setInterval(() => {
		if (busy) return;
		busy = true;
		void stopIdleSandboxes()
			.catch((error: unknown) => logProblem('warn', 'Stopping idle sandboxes failed', error))
			.finally(() => (busy = false));
	}, SWEEP_MS).unref();
}
