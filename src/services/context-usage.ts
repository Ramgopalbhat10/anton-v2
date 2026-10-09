import { announce } from '../core/changes.ts';
import { sessionCalls } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { logProblem } from './log.ts';
import { findModel } from './models.ts';

/**
 * How full each task's context window is, and with what. The runtime tells
 * Anton, for every model call, the request it sent (system prompt, tools,
 * messages) and the tokens the provider counted. The request is measured by
 * size, split into the parts below, and scaled so the parts add up to the
 * provider's own count, which is what the runtime compacts on.
 */

export type ContextPart = 'messages' | 'tools' | 'systemPrompt' | 'skills' | 'mcpTools';

type Snapshot = {
	/** `<gateway>/<model>`, the way tasks name their model. */
	model: string;
	/** Tokens the provider counted for the last call: its whole input plus its reply, the runtime's measure of the context. */
	used: number;
	/** The parts' relative sizes, in estimated tokens, before scaling to `used`. */
	estimates: Record<ContextPart, number>;
	at: string;
};

export type ContextView = {
	model: string | null;
	/** The model's context window in tokens; 0 when unknown. */
	window: number;
	used: number;
	/** Where the runtime compacts the conversation: the window less room kept for the next reply. */
	autocompactAt: number;
	parts: Array<{ key: ContextPart; tokens: number }>;
	at: string | null;
	/**
	 * Every model call the task made and the tokens they processed in all. Each call re-reads the
	 * conversation, so this grows much faster than `used`, which is what the window holds now.
	 */
	task: { calls: number; tokens: number };
};

/** The runtime's rule of thumb, which Anton follows for sizes it measures itself. */
const estimate = (text: string) => Math.ceil(text.length / 4);

type ModelRequestInput = { systemPrompt?: string; messages?: unknown[]; tools?: Array<{ name?: string }> };
type ContextEvent = {
	type: string;
	instanceId?: string;
	session?: string;
	agentName?: string;
	taskId?: string;
	turnId?: string;
	purpose?: string;
	request?: { providerId?: string; requestedModel?: string; input?: ModelRequestInput };
	response?: { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } };
};

/** The skills list the runtime adds to the system prompt, under its own heading. */
function splitSkills(prompt: string): { skills: string; rest: string } {
	const start = prompt.indexOf('## Available Skills');
	if (start === -1) return { skills: '', rest: prompt };
	const next = prompt.indexOf('\n## ', start + 1);
	const end = next === -1 ? prompt.length : next;
	return { skills: prompt.slice(start, end), rest: prompt.slice(0, start) + prompt.slice(end) };
}

export function measureRequest(input: ModelRequestInput): Record<ContextPart, number> {
	const { skills, rest } = splitSkills(input.systemPrompt ?? '');
	const tools = input.tools ?? [];
	const mcp = tools.filter((tool) => tool.name?.startsWith('mcp__'));
	const own = tools.filter((tool) => !tool.name?.startsWith('mcp__'));
	return {
		systemPrompt: estimate(rest),
		skills: estimate(skills),
		tools: estimate(JSON.stringify(own)),
		mcpTools: estimate(JSON.stringify(mcp)),
		messages: estimate(JSON.stringify(input.messages ?? [])),
	};
}

/** The runtime's name for an agent's main conversation; a subagent's task gets a session of its own. */
export const MAIN_SESSION = 'default';

/** The coding agent's own calls in its main conversation, not a subagent's, the reviewer's, or a compaction's. */
const isTaskCall = (event: ContextEvent) =>
	Boolean(event.instanceId) &&
	!event.taskId &&
	(event.session === undefined || event.session === MAIN_SESSION) &&
	event.purpose === 'agent' &&
	(!event.agentName || /^coder$/i.test(event.agentName));

/** Requests seen, waiting for their call to finish; keyed by task and turn. */
const pending = new Map<string, Record<ContextPart, number>>();
const key = (id: string) => `context.${id}`;

export async function recordContext(event: ContextEvent): Promise<void> {
	if (!isTaskCall(event) || !event.turnId) return;
	const id = event.instanceId!;
	if (event.type === 'turn_request' && event.request?.input) {
		pending.set(`${id} ${event.turnId}`, measureRequest(event.request.input));
		return;
	}
	if (event.type !== 'turn') return;
	const estimates = pending.get(`${id} ${event.turnId}`);
	pending.delete(`${id} ${event.turnId}`);
	const usage = event.response?.usage;
	if (!estimates || !usage) return;
	const used = usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	if (!used) return;
	// The reply joins the conversation, so it counts with the messages.
	const snapshot: Snapshot = {
		model: `${event.request?.providerId}/${event.request?.requestedModel}`,
		used,
		estimates: { ...estimates, messages: estimates.messages + (usage.output ?? 0) },
		at: new Date().toISOString(),
	};
	await setSetting(key(id), snapshot).catch((error: unknown) => logProblem('warn', 'Context usage not kept', error, id));
	announce({ kind: 'task', id, what: 'state' });
}

/** The runtime keeps room for the next reply: up to 20K tokens, no more than the model can write, and a third of a small window. */
export function compactionReserve(window: number, maxOutput: number | null): number {
	let reserve = Math.min(20_000, maxOutput && maxOutput > 0 ? maxOutput : 20_000);
	if (window > 0 && reserve * 2 >= window) reserve = Math.max(1024, Math.floor(window / 3));
	return reserve;
}

/** Shares `total` across the parts by their estimated sizes, in whole tokens that add up exactly. */
export function scaleParts(estimates: Record<ContextPart, number>, total: number): Array<{ key: ContextPart; tokens: number }> {
	const order: ContextPart[] = ['messages', 'tools', 'systemPrompt', 'skills', 'mcpTools'];
	const sum = order.reduce((acc, part) => acc + estimates[part], 0);
	if (!sum) return order.map((part) => ({ key: part, tokens: part === 'messages' ? total : 0 }));
	const parts = order.map((part) => ({ key: part, tokens: Math.floor((estimates[part] / sum) * total) }));
	parts[0].tokens += total - parts.reduce((acc, part) => acc + part.tokens, 0);
	return parts;
}

export async function contextView(id: string): Promise<ContextView> {
	const [snapshot, task] = await Promise.all([getSetting<Snapshot | null>(key(id), null), sessionCalls(id)]);
	if (!snapshot) return { model: null, window: 0, used: 0, autocompactAt: 0, parts: [], at: null, task };
	const info = await findModel(snapshot.model).catch(() => undefined);
	const window = info?.contextLength ?? 0;
	return {
		model: snapshot.model,
		window,
		used: snapshot.used,
		autocompactAt: window ? window - compactionReserve(window, info?.maxOutput ?? null) : 0,
		parts: scaleParts(snapshot.estimates, snapshot.used),
		at: snapshot.at,
		task,
	};
}
