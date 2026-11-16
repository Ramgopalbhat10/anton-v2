import type { AgentNow } from '../../core/agent-now.ts';
import { announce } from '../../core/changes.ts';

// The runtime's live events (model calls, thinking, streaming tool input) are never replayed, so the latest is kept in memory and announced whole.

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
	running: Map<string, { tool: string; detail: string | null; since: string }>;
	writing: Map<string, { tool: string; head: string; chars: number }>;
	timer: { handle: ReturnType<typeof setTimeout>; settling: boolean } | null;
	said: string;
};

const tasks = new Map<string, Live>();

/** So a step that ends as the next begins is said once. */
const SETTLE_MS = 200;
const GROWTH_MS = 1000;
const HEAD_CHARS = 2000;

/** The runtime's name for an agent's main conversation; a subagent's task gets a session of its own. */
const MAIN_SESSION = 'default';

const isMain = (event: NowEvent) =>
	Boolean(event.instanceId) && !event.taskId && (event.session === undefined || event.session === MAIN_SESSION) && (!event.agentName || /^coder$/i.test(event.agentName));

export function agentNow(id: string): AgentNow | null {
	return tasks.get(id)?.now ?? null;
}

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

const PATCHED_FILE = /\*\*\* (?:Add|Update|Delete) File: ([^\n]+)\n/;

export function detailOf(tool: string, input: unknown, head = ''): string | null {
	const path = inputField(input, head, 'path') ?? (tool === 'apply_patch' ? (PATCHED_FILE.exec(inputField(input, head, 'input') ?? '')?.[1]?.trim() ?? null) : null);
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

function set(live: Live, next: Omit<AgentNow, 'since'>, at: string): void {
	const same = live.now && live.now.what === next.what && live.now.tool === next.tool && live.now.detail === next.detail;
	live.now = { ...next, since: same ? live.now!.since : at };
}

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

/** Runs in the event observer; never throws. */
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
			// Compaction's summaries are model calls too, one or two at once: the conversation is still being compacted until it says it is done.
			if (event.purpose && event.purpose !== 'agent') return;
			if (!live.running.size) set(live, { what: 'finishing', tool: null, detail: null, chars: 0 }, at);
			break;
		case 'compaction':
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
