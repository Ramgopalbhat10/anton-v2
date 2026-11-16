import { unrouted } from '../../core/model-route.ts';
import type { Usage } from '../../core/types.ts';
import { loadedModels } from './models.ts';
import { onPlan, planOf } from './subscriptions.ts';
import { addUsage, toUsage } from './usage.ts';

/**
 * The runtime reports a reply's usage for the agent's own conversation only, so subagents' calls are added up here.
 * Every call resends the whole conversation, so tokens add up each call's context; the peak context is kept apart.
 */

export type UsagePart = Usage & { calls: number };
/** `billing` is `plan` when every call ran on a plan, so nothing was charged per token. */
export type ReplyUsage = {
	main: UsagePart;
	subagents: UsagePart;
	billing: 'plan' | 'api';
	peak: number;
	model: string | null;
	compactions: Compaction[];
	compacting: number | null;
	last: number;
	/** Some providers report no tokens per call, so they were estimated from the text. */
	estimated: boolean;
	tools: ToolCalls;
};

export type ToolCalls = Record<string, Record<string, number>>;

/** `after` is null when the reply ended with it, so no call followed. */
export type Compaction = { at: string; before: number; after: number | null };

export type ReplyFacts = {
	context: { peak: number; window: number } | null;
	plan: { gateway: string; name: string } | null;
	compactions: Compaction[];
	estimated: boolean;
	/** Kept with the reply so a benchmark's tool mix is read without its raw events (`npm run tool:mix`). */
	tools: ToolCalls;
};

type CallUsage = Parameters<typeof toUsage>[0] & { totalTokens?: number };
type TurnEvent = {
	type: string;
	instanceId?: string;
	agentName?: string;
	session?: string;
	taskId?: string;
	purpose?: string;
	isError?: boolean;
	estimatedTokens?: number;
	request?: { providerId?: string; requestedModel?: string };
	response?: { usage?: CallUsage; output?: { content?: Array<{ type: string; name?: string }> } };
};

/** Cursor counts a whole run at its end, so the bridge estimates each call from its text, all as input (`estimatedUsage` in src/flue/claude-code-models.ts). */
const ESTIMATED = new Set(['cursor']);

const empty = (): UsagePart => ({ inputTokens: 0, outputTokens: 0, cost: 0, cachedTokens: 0, calls: 0 });
const open = new Map<string, ReplyUsage>();

export function startReply(id: string): void {
	open.set(id, { main: empty(), subagents: empty(), billing: 'plan', peak: 0, last: 0, model: null, compactions: [], compacting: null, estimated: false, tools: {} });
}

const contextOf = (usage: CallUsage) => usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

/** The reviewer has replies of its own; a subagent's calls count whatever name they carry. Runs in the event observer, synchronously. */
export function countReplyCall(event: TurnEvent): void {
	if (!event.instanceId) return;
	if (event.agentName && /^reviewer$/i.test(event.agentName)) return;
	const reply = open.get(event.instanceId);
	if (!reply) return;
	const main = !event.taskId && (event.session === undefined || event.session === 'default');
	if (event.type === 'compaction_start') {
		if (main) reply.compacting = event.estimatedTokens ?? null;
		return;
	}
	if (event.type === 'compaction') {
		if (main && !event.isError) reply.compactions.push({ at: new Date().toISOString(), before: reply.compacting || reply.last, after: null });
		if (main) reply.compacting = null;
		return;
	}
	if (event.type !== 'turn' || !event.response?.usage) return;
	const part = main ? reply.main : reply.subagents;
	Object.assign(part, addUsage(part, toUsage(event.response.usage)), { calls: part.calls + 1 });
	const gateway = event.request?.providerId ?? '';
	for (const part of event.response.output?.content ?? []) {
		if (part.type !== 'toolCall' || !event.request?.requestedModel) continue;
		const tools = (reply.tools[unrouted(`${gateway}/${event.request.requestedModel}`)] ??= {});
		tools[part.name ?? 'tool'] = (tools[part.name ?? 'tool'] ?? 0) + 1;
	}
	// Compaction's summaries are billed with the agent's calls, but the window is measured on the agent's own.
	if (main && (event.purpose === undefined || event.purpose === 'agent')) {
		const context = contextOf(event.response.usage);
		reply.peak = Math.max(reply.peak, context);
		reply.last = context;
		const compacted = reply.compactions.at(-1);
		if (compacted && compacted.after === null) compacted.after = context;
		if (event.request?.requestedModel) reply.model = unrouted(`${gateway}/${event.request.requestedModel}`);
	}
	if (ESTIMATED.has(gateway)) reply.estimated = true;
	// A subagent on its own model may run on another gateway than the task's plan.
	if (!onPlan(`${gateway}/`)) reply.billing = 'api';
}

/** Only the dollars: its tokens are not the agent's. */
export function countReplySpend(id: string, cost: number): void {
	const reply = open.get(id);
	if (!reply || cost <= 0) return;
	reply.main.cost += cost;
	reply.billing = 'api';
}

export function finishReply(id: string): ReplyUsage | null {
	const reply = open.get(id) ?? null;
	open.delete(id);
	return reply && reply.main.calls + reply.subagents.calls > 0 ? reply : null;
}

export const replyTotal = ({ main, subagents }: ReplyUsage): Usage => addUsage(main, subagents);

export function replyFacts(reply: ReplyUsage, models = loadedModels()): ReplyFacts {
	const window = (reply.model && models.find((model) => model.id === reply.model)?.contextLength) || 0;
	return {
		context: reply.peak ? { peak: reply.peak, window } : null,
		plan: reply.billing === 'plan' && reply.model ? planOf(reply.model) : null,
		compactions: reply.compactions,
		estimated: reply.estimated,
		tools: reply.tools,
	};
}
