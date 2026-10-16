import { getSessionRecord } from '../db/sessions.ts';
import { isWorking } from './activity.ts';
import { userHasControl } from './computer.ts';
import { logProblem } from './log.ts';
import { sandboxSettings } from './sandbox-settings.ts';
import { runningKeys, stopSession } from './sessions.ts';
import { isStarting } from './workspace.ts';

/**
 * Stops a task's sandbox once nothing has happened in it for the idle minutes
 * in Settings › Sandboxes, as Stop does: a checkpoint first. The provider's own
 * idle timeout counts every command as use, and an open Files, Changes or
 * Library panel reads a running machine every few seconds, so on its own a
 * finished task's sandbox could run for as long as a page shows it. Here the
 * task is in use only while its agent works, a terminal is open on it, or you
 * have taken over its computer; reading its files is not use.
 */

/** When each running task's sandbox went quiet. */
const quietSince = new Map<string, number>();
/** Terminals open on each task. */
const terminals = new Map<string, number>();

/** How often running sandboxes are looked over. */
const SWEEP_MS = 60_000;

/** Counts something done in the task now, so its idle minutes start again. */
export function noteActive(id: string): void {
	quietSince.delete(id);
}

/** Keeps the task's sandbox up while a terminal is open on it; returns what to call when it closes. */
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

const inUse = (id: string) => isWorking(id) || isStarting(id) || terminals.has(id) || userHasControl(id);

/** Stops the sandboxes quiet for the idle minutes; returns the tasks stopped. Only this Anton's tasks, never another install's sandboxes. */
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
		const since = quietSince.get(id);
		if (since === undefined) {
			quietSince.set(id, now);
			continue;
		}
		if (now - since < idleMs) continue;
		quietSince.delete(id);
		// A sandbox of another install sharing the provider is not this Anton's to stop; a reply may have started meanwhile.
		if (!(await getSessionRecord(id)) || inUse(id)) continue;
		await stopSession(id).then(
			() => stopped.push(id),
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
