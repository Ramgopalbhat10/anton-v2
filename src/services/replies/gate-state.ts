import { isIncognitoId } from '../../core/incognito.ts';
import { getGateStateRow, saveGateStateRow } from '../../db/gate-state.ts';
import { logProblem } from '../../core/log.ts';

/*
 * What the checks at a reply's end know of a task, in memory and saved to the task's row after each change, so a reply the
 * runtime resumes after a restart carries on. A change made before the row is read is applied at once and again on the row.
 */

/** From its last message of substance on, as that is all its end is read from. */
export type Said = { start: number; texts: string[]; silent: boolean };

export type ReviewState = {
	seen?: string;
	files?: Record<string, string>;
	/** A reply that ends with the same one changed no code. */
	start?: string;
	startFiles?: Record<string, string>;
	reviewed: string[];
	/** Reviews made in the reply in hand, and how many past the bound the completion gate has let it make. */
	reviews: number;
	extra: number;
	/** Given its own check of its change (on a plan model), or of its work (a chat with no diff). */
	selfChecked: boolean;
	workChecked: boolean;
};

export type GateState = {
	request?: string;
	review: ReviewState;
	round?: { rounds: number; mark: string; seen: number };
	reminded: boolean;
	nudged: boolean;
	clock?: { started: number; told?: number };
	said: Said;
	check: CheckState;
	compacted?: boolean;
	sendBacks?: SendBack[];
	/** Queued by `open_pull_request`, pushed when the reply ends (`push-gate.ts`). */
	pullRequest?: { title: string; body: string };
	pushTries?: number;
	/** The change the last bug review before a push was asked for, and whether the reply in hand asked for one (`pre-push-review.ts`). */
	bugsReviewed?: string;
	bugsAsked?: boolean;
	/** Review comments answered with answer_review_comment this reply, and whether the reply was sent back for the rest. */
	answered?: string[];
	answersAsked?: boolean;
	/** The user was told a push failed; cleared with the error once one goes through. */
	pushFailed?: boolean;
};

export type GateName = 'todo' | 'stall' | 'jobs' | 'check' | 'review' | 'completion' | 'bugs' | 'answers' | 'push';

/** `changed` and `worked` are set when the reply next comes to an end. */
export type SendBack = { gate: GateName; calls: number; said: number; changed?: boolean; worked?: boolean; points?: string; before?: string };

/** `told`: the failure's digest hash or that it timed out; nothing once it passes again. */
export type CheckState = { told?: string; ran: boolean; sent: string[]; sends: number };

const fresh = (): GateState => ({
	review: { reviewed: [], reviews: 0, extra: 0, selfChecked: false, workChecked: false },
	reminded: false,
	nudged: false,
	said: { start: 0, texts: [], silent: false },
	check: { ran: false, sent: [], sends: 0 },
});

function parse(json: string): GateState {
	const saved = JSON.parse(json) as Partial<GateState>;
	const base = fresh();
	return { ...base, ...saved, review: { ...base.review, ...saved.review }, said: { ...base.said, ...saved.said }, check: { ...base.check, ...saved.check } };
}

type Change = (state: GateState) => void;
type Entry = {
	state: GateState;
	load: Promise<void> | null;
	loaded: boolean;
	early: Change[];
	timer?: ReturnType<typeof setTimeout>;
};

/** The least recently touched dropped first; the row is what makes dropping one safe. */
const KEEP_TASKS = 200;
const WRITE_DELAY_MS = 250;

const entries = new Map<string, Entry>();
/** A read of its row waits for it, so a task dropped and read again gets what it had. */
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

/** Read only: change it with `changeGate`. */
export function gate(id: string): Readonly<GateState> {
	return entries.get(id)?.state ?? fresh();
}

export function changeGate(id: string, change: Change): void {
	const entry = entryFor(id);
	change(entry.state);
	if (entry.loaded) schedule(id, entry);
	else entry.early.push(change);
}

/** Every check at a reply's end waits for it first. An incognito task has no row. */
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

export async function flushGates(): Promise<void> {
	for (const [id, entry] of entries) {
		if (!entry.timer) continue;
		clearTimeout(entry.timer);
		write(id, entry);
	}
	await Promise.all([...writes.values()]);
}

export function forgetGate(id: string): void {
	const entry = entries.get(id);
	if (entry?.timer) clearTimeout(entry.timer);
	entries.delete(id);
}

export async function restartGates(): Promise<void> {
	await flushGates();
	entries.clear();
}
