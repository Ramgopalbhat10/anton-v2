import { unrouted } from '../core/model-route.ts';
import type { Usage } from '../core/types.ts';
import { loadedModels } from './models.ts';
import { onPlan } from './subscriptions.ts';
import { addUsage, toUsage } from './usage.ts';

/**
 * What one reply of the coding agent used, its subagents included. The runtime
 * reports a reply's usage for the agent's own conversation only; a subagent's
 * calls (the browser subagent reading pages, say) are billed just the same,
 * so they are added up here from each model call as it finishes.
 *
 * Every call sends the whole conversation again, so a reply's tokens add up
 * each call's context: a reply of eight calls on a 380K conversation reads
 * about 3M tokens. The largest context one call held is kept apart, as the
 * measure of how full the window got.
 */

export type UsagePart = Usage & { calls: number };
/** `billing` is `plan` when every call ran on a plan, so nothing was charged per token. */
export type ReplyUsage = {
	main: UsagePart;
	subagents: UsagePart;
	billing: 'plan' | 'api';
	/** The largest context one of the agent's own calls held, in tokens, as the runtime measures it to compact. */
	peak: number;
	/** The model of the agent's own calls, the way tasks name it. */
	model: string | null;
	/** Times the conversation was compacted during the reply. */
	compactions: number;
	/** Some calls' tokens were estimated from their text, as their provider reports none per call. */
	estimated: boolean;
};

/** What the thread shows beside a reply's tokens: how full the window got, compactions, and whether the counts are estimates. */
export type ReplyFacts = { context: { peak: number; window: number } | null; compactions: number; estimated: boolean };

type CallUsage = Parameters<typeof toUsage>[0] & { totalTokens?: number };
type TurnEvent = {
	type: string;
	instanceId?: string;
	agentName?: string;
	session?: string;
	taskId?: string;
	purpose?: string;
	isError?: boolean;
	request?: { providerId?: string; requestedModel?: string };
	response?: { usage?: CallUsage };
};

/**
 * Gateways whose agent reports no one call's tokens: Cursor counts a whole run at its end, so the
 * bridge counts each call by the text it sends (`estimatedUsage` in src/flue/claude-code-models.ts),
 * all of it as input, with nothing read from a cache.
 */
const ESTIMATED = new Set(['cursor']);

const empty = (): UsagePart => ({ inputTokens: 0, outputTokens: 0, cost: 0, cachedTokens: 0, calls: 0 });
const open = new Map<string, ReplyUsage>();

/** A reply starts: count its calls from now. */
export function startReply(id: string): void {
	open.set(id, { main: empty(), subagents: empty(), billing: 'plan', peak: 0, model: null, compactions: 0, estimated: false });
}

/** A call's context as the runtime measures it to decide on compaction: all it was sent, and its reply. */
const contextOf = (usage: CallUsage) => usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

/**
 * Adds a finished model call to the task's open reply. The reviewer, the one
 * other agent working under a task's id, has replies of its own; a subagent's
 * calls count whatever name they carry. Runs in the event observer, synchronously.
 */
export function countReplyCall(event: TurnEvent): void {
	if (!event.instanceId) return;
	if (event.agentName && /^reviewer$/i.test(event.agentName)) return;
	const reply = open.get(event.instanceId);
	if (!reply) return;
	const main = !event.taskId && (event.session === undefined || event.session === 'default');
	if (event.type === 'compaction') {
		if (main && !event.isError) reply.compactions += 1;
		return;
	}
	if (event.type !== 'turn' || !event.response?.usage) return;
	const part = main ? reply.main : reply.subagents;
	Object.assign(part, addUsage(part, toUsage(event.response.usage)), { calls: part.calls + 1 });
	const gateway = event.request?.providerId ?? '';
	// Compaction's summaries are billed with the agent's calls, but the window is measured on the agent's own.
	if (main && (event.purpose === undefined || event.purpose === 'agent')) {
		reply.peak = Math.max(reply.peak, contextOf(event.response.usage));
		if (event.request?.requestedModel) reply.model = unrouted(`${gateway}/${event.request.requestedModel}`);
	}
	if (ESTIMATED.has(gateway)) reply.estimated = true;
	// A subagent on its own model may run on another gateway than the task's plan.
	if (!onPlan(`${gateway}/`)) reply.billing = 'api';
}

/**
 * Adds what a tool paid for on the side (an image model's picture, say) to the
 * task's open reply, so the reply's cost says what it spent. Only the dollars:
 * its tokens are not the agent's.
 */
export function countReplySpend(id: string, cost: number): void {
	const reply = open.get(id);
	if (!reply || cost <= 0) return;
	reply.main.cost += cost;
	reply.billing = 'api';
}

/** The reply's calls, ending the count; null when its start was not seen (a reply resumed after a restart). */
export function finishReply(id: string): ReplyUsage | null {
	const reply = open.get(id) ?? null;
	open.delete(id);
	return reply && reply.main.calls + reply.subagents.calls > 0 ? reply : null;
}

/** Both parts together, as the reply's usage. */
export const replyTotal = ({ main, subagents }: ReplyUsage): Usage => addUsage(main, subagents);

/** The reply's facts for the thread, with the window of the model its agent ran on (0 when it is not listed). */
export function replyFacts(reply: ReplyUsage, models = loadedModels()): ReplyFacts {
	const window = (reply.model && models.find((model) => model.id === reply.model)?.contextLength) || 0;
	return { context: reply.peak ? { peak: reply.peak, window } : null, compactions: reply.compactions, estimated: reply.estimated };
}
