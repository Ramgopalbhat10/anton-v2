import { FILE_CHANGE_TOOLS } from '../core/tool-profile.ts';
import { changeGate, type GateName, gate, type SendBack } from './gate-state.ts';
import { replyEnding, replyMessages } from './reply-check.ts';

/*
 * What became of each send-back. The checks at a reply's end (the todo reminder, the stall check, the jobs and
 * repository-check gates, the finish review and the completion gate) send a reply back for another round, and each
 * round is a model call over the whole conversation. A live run found most of them sent back replies that had nothing
 * left to do, so each send-back is noted here, and when the reply next comes to an end it is marked with whether the
 * agent then changed a file or worked in its sandbox. The reply's metadata keeps the marks (`sendBacks`), and
 * `npm run gates:report` adds them up per check: how often each sends a reply back, and how often that led to a change.
 */

type Call = { tool: string };

/** Work in the sandbox, as the completion gate counts it; a file change is the stronger sign that a send-back was needed. */
const SANDBOX_TOOLS = new Set(['bash', 'run_in_background', ...FILE_CHANGE_TOOLS]);
/** How much of a review's points and of what the reply said before them is kept for the completion gate. */
const POINTS_CHARS = 2_000;
const BEFORE_CHARS = 3_000;
/** Send-backs kept a reply; the checks' own bounds keep a reply far under this. */
const KEEP = 40;

/** A new reply starts with no send-backs. */
export function startSendBacks(id: string): void {
	changeGate(id, (state) => {
		state.sendBacks = [];
	});
}

/**
 * Notes that `gate` sent the reply back, `calls` tool calls into it. A review's points and what the reply had said
 * before them are kept, so the completion gate can read a reply that answers a reviewer for what it is.
 */
export function noteSendBack(id: string, name: GateName, calls: number, body: string): void {
	const entry: SendBack = { gate: name, calls, said: replyMessages(id) };
	if (name === 'review') {
		entry.points = body.slice(0, POINTS_CHARS);
		entry.before = replyEnding(id).slice(-BEFORE_CHARS);
	}
	changeGate(id, (state) => {
		state.sendBacks = [...(state.sendBacks ?? []), entry].slice(-KEEP);
	});
}

/** Marks each send-back not yet marked with what the agent did after it, from the reply's tool calls so far. */
export function settleSendBacks(id: string, calls: readonly Call[]): void {
	if (!gate(id).sendBacks?.some((entry) => entry.changed === undefined)) return;
	changeGate(id, (state) => {
		for (const entry of state.sendBacks ?? []) {
			if (entry.changed !== undefined) continue;
			const after = calls.slice(entry.calls);
			entry.changed = after.some((call) => FILE_CHANGE_TOOLS.has(call.tool));
			entry.worked = after.some((call) => SANDBOX_TOOLS.has(call.tool));
		}
	});
}

/** The last send-back of the reply in hand, if any. */
export const lastSendBack = (id: string): SendBack | undefined => gate(id).sendBacks?.at(-1);

/** The reply's send-backs as its metadata keeps them: which check, and whether the agent then changed or ran anything. */
export function sendBacksOf(id: string): Array<{ gate: GateName; changed: boolean; worked: boolean }> {
	return (gate(id).sendBacks ?? []).map((entry) => ({ gate: entry.gate, changed: entry.changed ?? false, worked: entry.worked ?? false }));
}
