import { config } from '../../config.ts';
import { changeGate, gate } from './gate-state.ts';

// A model has no clock and misjudges long jobs by hours (one gave up at "5 hours" 85 minutes in), so a command's result tells it the time.

export const CLOCK_AFTER_MS = 10 * 60_000;
export const CLOCK_EVERY_MS = 10 * 60_000;

export function startReplyClock(id: string, now = Date.now()): void {
	changeGate(id, (state) => {
		state.clock = { started: now };
	});
}

export function elapsedText(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	const hours = Math.floor(minutes / 60);
	return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** From config only, so the system prompt that carries it is the same on every render. */
export function hoursText(ms: number): string {
	const hours = Math.round((ms / 3_600_000) * 10) / 10;
	return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export function replyElapsed(id: string, now = Date.now()): number | null {
	const since = gate(id).clock?.started;
	return since === undefined ? null : Math.max(0, now - since);
}

/** Empty for a reply whose start is not known here, rather than a time that starts from some later moment. */
export function elapsedNote(id: string, now = Date.now(), limitMs = config.replyTimeoutMs): string {
	const clock = gate(id).clock;
	const since = clock?.started;
	if (since === undefined || now - since < CLOCK_AFTER_MS) return '';
	const last = clock?.told;
	if (last !== undefined && now - last < CLOCK_EVERY_MS) return '';
	changeGate(id, (state) => {
		if (state.clock) state.clock.told = now;
	});
	return `\n[anton] ${elapsedText(now - since)} since this reply started, of ${hoursText(limitMs)} allowed.`;
}
