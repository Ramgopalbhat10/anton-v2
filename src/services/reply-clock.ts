import { config } from '../config.ts';
import { changeGate, gate } from './gate-state.ts';

/*
 * How long the reply in hand has run, told to the agent with a command's
 * result. A model has no clock: on a long job it judges the time gone by how
 * much it has done, and gets it wrong by hours (a proof it gave up as out of
 * time at "5 hours" was 85 minutes in, with 8 hours allowed). So once a reply
 * has run a while, a command's result says how long it has been, at most once
 * every few minutes: a dozen tokens each, and none at all on a short reply.
 * The line names the limit too, so the time gone reads against the time left.
 */

/** A reply shorter than this is never told the time: most replies are, and need no clock. */
export const CLOCK_AFTER_MS = 10 * 60_000;
/** The time is told again only this long after it was last told. */
export const CLOCK_EVERY_MS = 10 * 60_000;

/** A reply starts: its time counts from now. Its start is kept with the task's checks, so a reply resumed after a restart counts on. */
export function startReplyClock(id: string, now = Date.now()): void {
	changeGate(id, (state) => {
		state.clock = { started: now };
	});
}

/** `1h 25m`, or `25m` under an hour. */
export function elapsedText(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	const hours = Math.floor(minutes / 60);
	return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/**
 * How long a reply may run, in words: `4 hours`, `1 hour`, `1.5 hours`. Told to the agent so it does not cut a job
 * down for time it has; from config only, so the system prompt that carries it is the same on every render.
 */
export function hoursText(ms: number): string {
	const hours = Math.round((ms / 3_600_000) * 10) / 10;
	return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** How long the reply in hand has run, or null when its start is not known here. */
export function replyElapsed(id: string, now = Date.now()): number | null {
	const since = gate(id).clock?.started;
	return since === undefined ? null : Math.max(0, now - since);
}

/**
 * The line a command's result ends with when the reply has run long enough and has not been told lately; empty
 * otherwise, and for a reply whose start is not known here, which is told nothing rather than a time that starts
 * from some later moment.
 */
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
