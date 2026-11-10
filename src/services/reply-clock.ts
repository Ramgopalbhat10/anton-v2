/*
 * How long the reply in hand has run, told to the agent with a command's
 * result. A model has no clock: on a long job it judges the time gone by how
 * much it has done, and gets it wrong by hours (a proof it gave up as out of
 * time at "5 hours" was 85 minutes in, with 8 hours allowed). So once a reply
 * has run a while, a command's result says how long it has been, at most once
 * every few minutes: a dozen tokens each, and none at all on a short reply.
 */

/** A reply shorter than this is never told the time: most replies are, and need no clock. */
export const CLOCK_AFTER_MS = 10 * 60_000;
/** The time is told again only this long after it was last told. */
export const CLOCK_EVERY_MS = 10 * 60_000;

const started = new Map<string, number>();
const told = new Map<string, number>();
const KEEP_TASKS = 500;

/** A reply starts: its time counts from now. */
export function startReplyClock(id: string, now = Date.now()): void {
	started.delete(id);
	started.set(id, now);
	told.delete(id);
	if (started.size > KEEP_TASKS) {
		const oldest = started.keys().next().value!;
		started.delete(oldest);
		told.delete(oldest);
	}
}

/** `1h 25m`, or `25m` under an hour. */
export function elapsedText(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	const hours = Math.floor(minutes / 60);
	return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/**
 * The line a command's result ends with when the reply has run long enough and has not been told lately; empty
 * otherwise, and for a reply whose start is not known here (one resumed after a restart), which is told nothing
 * rather than a time that starts at the restart.
 */
export function elapsedNote(id: string, now = Date.now()): string {
	const since = started.get(id);
	if (since === undefined || now - since < CLOCK_AFTER_MS) return '';
	const last = told.get(id);
	if (last !== undefined && now - last < CLOCK_EVERY_MS) return '';
	told.set(id, now);
	return `\n[anton] ${elapsedText(now - since)} since this reply started.`;
}
