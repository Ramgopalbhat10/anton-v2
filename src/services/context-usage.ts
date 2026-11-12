import type { Reasoning } from '../core/ports.ts';
import { announce } from '../core/changes.ts';
import { unrouted } from '../core/model-route.ts';
import { sessionCalls } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { backgroundModel, backgroundReasoning, compactionCeilingFor, generalSettings } from './general.ts';
import { logProblem } from './log.ts';
import { findModel, loadedModels } from './models.ts';

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
	/** Where the runtime compacts the conversation: the window less room kept for the next reply, or the ceiling from Settings › General. */
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

/** An event of the coding agent's main conversation, not a subagent's or the reviewer's. */
export const onMainCoder = (event: Pick<ContextEvent, 'instanceId' | 'taskId' | 'session' | 'agentName'>) =>
	Boolean(event.instanceId) && !event.taskId && (event.session === undefined || event.session === MAIN_SESSION) && (!event.agentName || /^coder$/i.test(event.agentName));

/** The coding agent's own calls in its main conversation, not a subagent's, the reviewer's, or a compaction's. */
const isTaskCall = (event: ContextEvent) => onMainCoder(event) && event.purpose === 'agent';

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
		model: unrouted(`${event.request?.providerId}/${event.request?.requestedModel}`),
		used,
		estimates: { ...estimates, messages: estimates.messages + (usage.output ?? 0) },
		at: new Date().toISOString(),
	};
	await setSetting(key(id), snapshot).catch((error: unknown) => logProblem('warn', 'Context usage not kept', error, id));
	announce({ kind: 'task', id, what: 'state' });
}

/**
 * The runtime keeps room for the next reply: up to 20K tokens, no more than the model can write, and a third of a small window.
 * With a ceiling (Settings › General) that comes first, the rest of the window is kept too, so it compacts there.
 */
export function compactionReserve(window: number, maxOutput: number | null, ceiling: number | null = null): number {
	let reserve = Math.min(20_000, maxOutput && maxOutput > 0 ? maxOutput : 20_000);
	if (window > 0 && reserve * 2 >= window) reserve = Math.max(1024, Math.floor(window / 3));
	if (ceiling && window - reserve > ceiling) reserve = window - ceiling;
	return reserve;
}

/**
 * How much of the latest conversation a compaction keeps word for word: a fifth of the context it compacts
 * at, from the runtime's 8K up to 40K. The runtime keeps 8K, about the last few tool results, so a coding
 * agent compacted mid-task lost the files and test output it was working from and spent its next calls
 * reading them again. A compaction starts the prompt cache over whatever it keeps, so keeping more costs
 * nothing then, and every call after reads it from the cache.
 */
export function keptAfterCompaction(compactsAt: number): number {
	return Math.min(40_000, Math.max(8_000, Math.floor(compactsAt / 5)));
}

/**
 * The effort a compaction summary is written at by the conversation's own model, when Settings › General names
 * no compaction model. Flue writes it at `high`. The summary call shares no prefix with the conversation, so none
 * of it is read from the prompt cache, and the reply waits for it: a frontier model thinking hard over 200K
 * tokens kept a task still for minutes in the middle of its work. A summary extracts what happened and decides
 * nothing, so it needs little thinking. The task's own model still writes it, as the one model certain to be
 * reachable on the task's plan or gateway and billed where the task is.
 */
export const COMPACTION_SUMMARY_EFFORT: Reasoning = 'low';

/**
 * The runtime's compaction for an agent on `model`: at the ceiling set in Settings › General when that
 * comes before the window fills (Claude Code's models have a ceiling of their own), else at the runtime's
 * own point, keeping what `keptAfterCompaction` says; and the summary written by the compaction model
 * chosen there (a faster one makes compacting quicker) at the effort chosen with it, else by the agent's
 * own at `COMPACTION_SUMMARY_EFFORT`. For a model of unknown window the point is left to the runtime.
 * Read while the agent renders, from the model list last fetched.
 */
export function compactionFor(
	model: string,
	ceiling = compactionCeilingFor(unrouted(model)),
	models = loadedModels(),
	summarizer = backgroundModel('compaction'),
	effort = backgroundReasoning('compaction'),
): { reserveTokens?: number; keepRecentTokens?: number; model?: string; reasoning?: Reasoning } {
	// `reasoning` is read by Anton's patch to Flue's summary call (scripts/patch-flue.ts), with a compaction model or
	// without one; a compaction model chosen with no effort beside it writes at the runtime's high, as it always has.
	const summary = summarizer ? { model: summarizer, ...(effort ? { reasoning: effort } : {}) } : { reasoning: COMPACTION_SUMMARY_EFFORT };
	const info = models.find((entry) => entry.id === unrouted(model));
	if (!info?.contextLength) return summary;
	const reserve = compactionReserve(info.contextLength, info.maxOutput, ceiling);
	const keepRecentTokens = keptAfterCompaction(info.contextLength - reserve);
	return reserve === compactionReserve(info.contextLength, info.maxOutput) ? { keepRecentTokens, ...summary } : { reserveTokens: reserve, keepRecentTokens, ...summary };
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
	const [info, settings] = await Promise.all([findModel(snapshot.model).catch(() => undefined), generalSettings()]);
	const compactAt = compactionCeilingFor(snapshot.model, settings);
	const window = info?.contextLength ?? 0;
	return {
		model: snapshot.model,
		window,
		used: snapshot.used,
		autocompactAt: window ? window - compactionReserve(window, info?.maxOutput ?? null, compactAt) : 0,
		parts: scaleParts(snapshot.estimates, snapshot.used),
		at: snapshot.at,
		task,
	};
}
