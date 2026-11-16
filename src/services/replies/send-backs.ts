import { FILE_CHANGE_TOOLS } from '../../core/tool-profile.ts';
import { changeGate, type GateName, gate, type SendBack } from './gate-state.ts';
import { replyEnding, replyMessages } from './reply-check.ts';

// Each send-back is a model call over the whole conversation; marking whether the agent then changed anything lets
// `npm run gates:report` show how often each check's send-backs were needed.

type Call = { tool: string };

/** A file change is the stronger sign that a send-back was needed. */
const SANDBOX_TOOLS = new Set(['bash', 'run_in_background', ...FILE_CHANGE_TOOLS]);
const POINTS_CHARS = 2_000;
const BEFORE_CHARS = 3_000;
const KEEP = 40;

export function startSendBacks(id: string): void {
	changeGate(id, (state) => {
		state.sendBacks = [];
	});
}

/** A review's points are kept so the completion gate can read a reply that answers a reviewer for what it is. */
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

export const lastSendBack = (id: string): SendBack | undefined => gate(id).sendBacks?.at(-1);

export function sendBacksOf(id: string): Array<{ gate: GateName; changed: boolean; worked: boolean }> {
	return (gate(id).sendBacks ?? []).map((entry) => ({ gate: entry.gate, changed: entry.changed ?? false, worked: entry.worked ?? false }));
}
