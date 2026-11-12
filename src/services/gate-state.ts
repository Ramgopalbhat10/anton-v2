import { isIncognitoId } from '../core/incognito.ts';
import { getGateStateRow, saveGateStateRow } from '../db/gate-state.ts';
import { logProblem } from './log.ts';

/*
 * What the checks at the end of a reply know of a task (`todos.ts`,
 * `reply-check.ts`, `finish-review.ts`, `completion-gate.ts`,
 * `reply-clock.ts`): the request, what the finish review last read, how often
 * each check sent the reply back, when the reply started and what it last
 * said. The runtime resumes a reply a restart interrupted, but this lived in
 * memory alone, so the resumed reply ended with no request to review against
 * and its counts and clock started over. It is kept in memory, so the checks
 * read it as they did, and saved to the task's row after each change, so a
 * task read again after a restart (or dropped from memory) carries on from it.
 *
 * A change made before the row is read is applied at once, so what reads it
 * next sees it, and again on the row once it is read, so the row's state is
 * the one that holds. The checks wait for the row at the end of a reply
 * (`loadGate`); the Coder starts reading it as soon as it renders.
 */

/** The agent's messages with words in the reply in hand: from its last of substance on, as that is all its end is read from. */
export type Said = { start: number; texts: string[]; silent: boolean };

export type ReviewState = {
	/** The change as last read, by hash, and each file's diff in it, by path. */
	seen?: string;
	files?: Record<string, string>;
	/** The change as the reply in hand found it: a reply that ends with the same one changed no code. */
	start?: string;
	startFiles?: Record<string, string>;
	/** The request and change of each review lately made, by hash, so the same pair is never reviewed twice. */
	reviewed: string[];
	/** Reviews made in the reply in hand, and how many past the bound the completion gate has let it make. */
	reviews: number;
	extra: number;
	/** Whether the reply in hand was given its own check of its change (on a plan model), or of its work (a chat with no diff). */
	selfChecked: boolean;
	workChecked: boolean;
};

export type GateState = {
	/** The message the user gave the task, whole up to a limit. */
	request?: string;
	review: ReviewState;
	/** The completion gate's rounds in the reply in hand. */
	round?: { rounds: number; mark: string; seen: number };
	/** Whether the reply in hand was reminded of its todo list, and sent back for a step it announced and never took. */
	reminded: boolean;
	nudged: boolean;
	/** When the reply in hand started, and when it was last told the time. */
	clock?: { started: number; told?: number };
	said: Said;
};

const fresh = (): GateState => ({
	review: { reviewed: [], reviews: 0, extra: 0, selfChecked: false, workChecked: false },
	reminded: false,
	nudged: false,
	said: { start: 0, texts: [], silent: false },
});

/** A saved state read back: anything it lacks (a field added since it was written) takes its default. */
function parse(json: string): GateState {
	const saved = JSON.parse(json) as Partial<GateState>;
	const base = fresh();
	return { ...base, ...saved, review: { ...base.review, ...saved.review }, said: { ...base.said, ...saved.said } };
}

type Change = (state: GateState) => void;
type Entry = {
	state: GateState;
	/** The row's read: null until asked for; it settles once the row's state is in `state`. */
	load: Promise<void> | null;
	loaded: boolean;
	/** Changes made before the row was read, applied again on it. */
	early: Change[];
	timer?: ReturnType<typeof setTimeout>;
};

/** Tasks held in memory, the least recently touched dropped first; the row is what makes dropping one safe. */
const KEEP_TASKS = 200;
/** Quick successive changes (a message, then a check) go out in one write. */
const WRITE_DELAY_MS = 250;

const entries = new Map<string, Entry>();
/** Each task's write in flight, which a read of its row waits for, so a task dropped and read again gets what it had. */
const writes = new Map<string, Promise<void>>();

function entryFor(id: string): Entry {
	let entry = entries.get(id);
	if (entry) {
		entries.delete(id);
		entries.set(id, entry);
		return entry;
	}
	entry = { state: fresh(), load: null, loaded: false, early: [] };
	entries.set(id, entry);
	if (entries.size > KEEP_TASKS) {
		const [oldest, dropped] = entries.entries().next().value!;
		entries.delete(oldest);
		if (dropped.timer) {
			clearTimeout(dropped.timer);
			write(oldest, dropped);
		}
	}
	return entry;
}

function write(id: string, entry: Entry): void {
	entry.timer = undefined;
	const json = JSON.stringify(entry.state);
	const next = (writes.get(id) ?? Promise.resolve())
		.then(() => saveGateStateRow(id, json))
		.catch((error: unknown) => logProblem('warn', 'The checks’ state was not saved', error, id));
	writes.set(id, next);
	void next.then(() => {
		if (writes.get(id) === next) writes.delete(id);
	});
}

function schedule(id: string, entry: Entry): void {
	if (!entry.loaded || isIncognitoId(id) || entry.timer) return;
	entry.timer = setTimeout(() => {
		if (entries.get(id) === entry) write(id, entry);
	}, WRITE_DELAY_MS);
	// A write still waiting when the process ends is lost; a resumed reply then has the state of a moment before.
	entry.timer.unref?.();
}

/** The task's state as the checks read it; the default for a task not seen. Read only: change it with `changeGate`. */
export function gate(id: string): Readonly<GateState> {
	return entries.get(id)?.state ?? fresh();
}

/** Changes the task's state now, and saves it once its row has been read. */
export function changeGate(id: string, change: Change): void {
	const entry = entryFor(id);
	change(entry.state);
	if (entry.loaded) schedule(id, entry);
	else entry.early.push(change);
}

/**
 * Reads the task's row the first time it is asked for in this process; at once after that. Every check that reads
 * the state at the end of a reply waits for it first. An incognito task keeps nothing, so it has no row to read.
 */
export function loadGate(id: string): Promise<void> {
	const entry = entryFor(id);
	entry.load ??= (async () => {
		let saved: string | null = null;
		if (!isIncognitoId(id)) {
			try {
				await writes.get(id);
				saved = await getGateStateRow(id);
			} catch (error) {
				logProblem('warn', 'The checks’ state was not read', error, id);
			}
		}
		if (saved !== null) {
			try {
				const state = parse(saved);
				for (const change of entry.early) change(state);
				entry.state = state;
			} catch (error) {
				logProblem('warn', 'The checks’ saved state could not be read', error, id);
			}
		}
		entry.loaded = true;
		const changed = entry.early.length > 0;
		entry.early = [];
		if (changed) schedule(id, entry);
	})();
	return entry.load;
}

/** Waits for every write in flight. */
export async function flushGates(): Promise<void> {
	for (const [id, entry] of entries) {
		if (!entry.timer) continue;
		clearTimeout(entry.timer);
		write(id, entry);
	}
	await Promise.all([...writes.values()]);
}

/** Forgets a deleted task's state; its row goes with the task's record. */
export function forgetGate(id: string): void {
	const entry = entries.get(id);
	if (entry?.timer) clearTimeout(entry.timer);
	entries.delete(id);
}

/** Saves what is waiting and forgets every task's state in memory, as a restart does; for tests. */
export async function restartGates(): Promise<void> {
	await flushGates();
	entries.clear();
}
