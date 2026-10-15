import type { AgentNow } from '../core/agent-now.ts';
import { announce } from '../core/changes.ts';

/**
 * What each task's agent is doing this moment. The conversation stream shows
 * a step only once it is whole, so a file the model is still writing, or a
 * long think, leaves the thread quiet for as long as it takes. The runtime's
 * live events say more (a model call starting, its thinking and text, a tool
 * call's input as it streams, the tools running) and are never replayed, so
 * Anton keeps the latest in memory and announces it whole.
 */

export type { AgentNow };

type NowEvent = {
	type: string;
	instanceId?: string;
	session?: string;
	agentName?: string;
	taskId?: string;
	purpose?: string;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	argumentTextDelta?: string;
	timestamp?: string;
};

type Live = {
	now: AgentNow | null;
	/** Tools running, in the order they started. */
	running: Map<string, { tool: string; detail: string | null; since: string }>;
	/** Tool calls the model is writing: the start of each one's input, for what it is about, and its length so far. */
	writing: Map<string, { tool: string; head: string; chars: number }>;
	/** The announcement waiting to go out: a change soon, or growth on the next beat. */
	timer: { handle: ReturnType<typeof setTimeout>; settling: boolean } | null;
	/** What the last announcement said, so growth alone waits for the next beat. */
	said: string;
};

const tasks = new Map<string, Live>();

/** Changes of state go out after this, so a step that ends as the next begins is said once. */
const SETTLE_MS = 200;
/** Growth of a file being written goes out at most this often. */
const GROWTH_MS = 1000;
/** Enough of a tool call's input to find what it is about. */
const HEAD_CHARS = 2000;

/** The runtime's name for an agent's main conversation; a subagent's task gets a session of its own. */
const MAIN_SESSION = 'default';

/** The coding agent's own conversation: not a subagent's, nor the reviewer's. */
const isMain = (event: NowEvent) =>
	Boolean(event.instanceId) && !event.taskId && (event.session === undefined || event.session === MAIN_SESSION) && (!event.agentName || /^coder$/i.test(event.agentName));

/** What the agent is doing now in a task, or null when it is not working or Anton has not heard since it started. */
export function agentNow(id: string): AgentNow | null {
	return tasks.get(id)?.now ?? null;
}

/** A string field of a tool's input, read whole or from the start of its JSON while it streams. */
function inputField(input: unknown, head: string, key: string): string | null {
	if (input && typeof input === 'object' && typeof (input as Record<string, unknown>)[key] === 'string') return (input as Record<string, string>)[key];
	const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(head);
	if (!match) return null;
	try {
		return JSON.parse(`"${match[1].replace(/\\$/, '')}"`) as string;
	} catch {
		return match[1];
	}
}

/** The few words that say what a tool call is for: its file, its command's first line, or its subagent. */
export function detailOf(tool: string, input: unknown, head = ''): string | null {
	const path = inputField(input, head, 'path');
	if (path) return path.replace(/^\.\//, '');
	if (tool === 'task') return inputField(input, head, 'agent') ?? inputField(input, head, 'description');
	const command = inputField(input, head, 'command');
	if (command) {
		const line = command.trim().split('\n')[0];
		return line.length > 80 ? `${line.slice(0, 79)}…` : line;
	}
	const url = inputField(input, head, 'url');
	return url ?? null;
}

function liveOf(id: string): Live {
	let live = tasks.get(id);
	if (!live) {
		live = { now: null, running: new Map(), writing: new Map(), timer: null, said: '' };
		tasks.set(id, live);
	}
	return live;
}

/** The same state, word for word, keeps its start; a new one starts now. */
function set(live: Live, next: Omit<AgentNow, 'since'>, at: string): void {
	const same = live.now && live.now.what === next.what && live.now.tool === next.tool && live.now.detail === next.detail;
	live.now = { ...next, since: same ? live.now!.since : at };
}

/** After a tool ends, the next running one, or the model reading what came back. */
function afterTool(live: Live, at: string): void {
	const last = [...live.running.values()].pop();
	if (last) live.now = { what: 'running', tool: last.tool, detail: last.detail, chars: 0, since: last.since };
	else set(live, { what: 'thinking', tool: null, detail: null, chars: 0 }, at);
}

const keyOf = (now: AgentNow | null) => (now ? `${now.what}\n${now.tool}\n${now.detail}\n${now.since}` : '');

function say(id: string, live: Live): void {
	const changed = keyOf(live.now) !== live.said;
	if (live.timer) {
		// A change already waiting goes out with whatever is latest by then; growth gives way to a change.
		if (live.timer.settling || !changed) return;
		clearTimeout(live.timer.handle);
	}
	const handle = setTimeout(
		() => {
			live.timer = null;
			live.said = keyOf(live.now);
			announce({ kind: 'now', id, now: live.now });
			if (!live.now && tasks.get(id) === live) tasks.delete(id);
		},
		changed ? SETTLE_MS : GROWTH_MS,
	);
	live.timer = { handle, settling: changed };
}

/** Records one runtime event about the coding agent's main conversation. Runs in the event observer; never throws. */
export function recordAgentNow(event: NowEvent): void {
	if (!isMain(event)) return;
	const id = event.instanceId!;
	const at = event.timestamp ?? new Date().toISOString();
	const live = liveOf(id);
	switch (event.type) {
		case 'turn_request':
			live.writing.clear();
			set(live, { what: event.purpose && event.purpose !== 'agent' ? 'compacting' : 'thinking', tool: null, detail: null, chars: 0 }, at);
			break;
		case 'compaction_start':
			set(live, { what: 'compacting', tool: null, detail: null, chars: 0 }, at);
			break;
		case 'thinking_start':
		case 'thinking_delta':
			if (live.now?.what !== 'thinking') set(live, { what: 'thinking', tool: null, detail: null, chars: 0 }, at);
			break;
		case 'text_delta':
			if (live.now?.what !== 'replying') set(live, { what: 'replying', tool: null, detail: null, chars: 0 }, at);
			break;
		case 'toolcall_delta': {
			if (!event.toolCallId || !event.toolName) return;
			const call = live.writing.get(event.toolCallId) ?? { tool: event.toolName, head: '', chars: 0 };
			const delta = event.argumentTextDelta ?? '';
			if (call.head.length < HEAD_CHARS) call.head += delta.slice(0, HEAD_CHARS - call.head.length);
			call.chars += delta.length;
			live.writing.set(event.toolCallId, call);
			set(live, { what: 'writing', tool: call.tool, detail: detailOf(call.tool, undefined, call.head), chars: call.chars }, at);
			break;
		}
		case 'tool_start':
			if (!event.toolCallId || !event.toolName) return;
			live.writing.delete(event.toolCallId);
			live.running.set(event.toolCallId, { tool: event.toolName, detail: detailOf(event.toolName, event.args), since: at });
			afterTool(live, at);
			break;
		case 'tool':
			if (!event.toolCallId) return;
			live.running.delete(event.toolCallId);
			afterTool(live, at);
			break;
		case 'turn':
			live.writing.clear();
			if (!live.running.size) set(live, { what: 'finishing', tool: null, detail: null, chars: 0 }, at);
			break;
		case 'submission_settled':
			live.running.clear();
			live.writing.clear();
			live.now = null;
			break;
		default:
			return;
	}
	say(id, live);
}
