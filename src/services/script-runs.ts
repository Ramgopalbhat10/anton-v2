import { announce } from '../core/changes.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { logProblem } from './log.ts';

/**
 * What each run_script program called, for the thread: the runtime only shows
 * the program and its result, so Anton keeps each call (tool, a short input,
 * how it went) as it happens, keyed by the run_script call's id. Kept in
 * memory while it runs and saved per task, so a reload still shows it.
 */

export type ScriptCall = { tool: string; input: string; state: 'running' | 'done' | 'failed'; durationMs: number | null };

/** A task keeps its latest programs; each program its first calls. */
const MAX_SCRIPTS = 40;
const MAX_CALLS = 100;
const MAX_INPUT = 160;

const key = (id: string) => `scripts.${id}`;
const scripts = new Map<string, Record<string, ScriptCall[]>>();
const loading = new Map<string, Promise<Record<string, ScriptCall[]>>>();

function scriptsOf(id: string): Promise<Record<string, ScriptCall[]>> {
	const known = scripts.get(id);
	if (known) return Promise.resolve(known);
	let pending = loading.get(id);
	if (!pending) {
		pending = getSetting<Record<string, ScriptCall[]>>(key(id), {})
			.catch(() => ({}))
			.then((stored) => {
				const kept = scripts.get(id) ?? stored ?? {};
				scripts.set(id, kept);
				loading.delete(id);
				return kept;
			});
		loading.set(id, pending);
	}
	return pending;
}

/** A call's input in one short line, as the thread shows it. */
export function shortInput(input: unknown): string {
	let text: string;
	try {
		text = typeof input === 'string' ? input : (JSON.stringify(input) ?? '');
	} catch {
		text = '';
	}
	text = text.replace(/\s+/g, ' ').trim();
	return text.length > MAX_INPUT ? `${text.slice(0, MAX_INPUT - 1)}…` : text;
}

// Open pages hear of changes, and they are saved, at most this often per task while a program runs.
const SETTLE_MS = 300;
const SAVE_MS = 2000;
const announcing = new Map<string, ReturnType<typeof setTimeout>>();
const saving = new Map<string, ReturnType<typeof setTimeout>>();

function changed(id: string) {
	if (!announcing.has(id)) {
		announcing.set(
			id,
			setTimeout(() => {
				announcing.delete(id);
				announce({ kind: 'task', id, what: 'scripts' });
			}, SETTLE_MS),
		);
	}
	clearTimeout(saving.get(id));
	saving.set(
		id,
		setTimeout(() => {
			saving.delete(id);
			const kept = scripts.get(id);
			if (kept) setSetting(key(id), kept).catch((error: unknown) => logProblem('warn', 'Could not save script calls', error, id));
		}, SAVE_MS),
	);
}

/** Records the calls one program has made so far. */
export async function noteScriptCalls(id: string, toolCallId: string, calls: ScriptCall[]): Promise<void> {
	const kept = await scriptsOf(id);
	if (!(toolCallId in kept)) {
		const ids = Object.keys(kept);
		for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_SCRIPTS + 1))) delete kept[stale];
	}
	kept[toolCallId] = calls.slice(0, MAX_CALLS).map((call) => ({ ...call, input: shortInput(call.input) }));
	changed(id);
}

/** Each program's calls, by its run_script call's id. */
export function scriptCalls(id: string): Promise<Record<string, ScriptCall[]>> {
	return scriptsOf(id);
}

/** Forgets a deleted task's programs. */
export async function forgetScriptCalls(id: string): Promise<void> {
	scripts.delete(id);
	clearTimeout(saving.get(id));
	saving.delete(id);
	await setSetting(key(id), null);
}
