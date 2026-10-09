import type { Usage } from '../core/types.ts';
import { toUsage } from './usage.ts';

/**
 * What one reply of the coding agent used, its subagents included. The runtime
 * reports a reply's usage for the agent's own conversation only; a subagent's
 * calls (the browser subagent reading pages, say) are billed just the same,
 * so they are added up here from each model call as it finishes.
 */

export type UsagePart = Usage & { calls: number };
export type ReplyUsage = { main: UsagePart; subagents: UsagePart };

type TurnEvent = {
	type: string;
	instanceId?: string;
	agentName?: string;
	session?: string;
	taskId?: string;
	response?: { usage?: Parameters<typeof toUsage>[0] };
};

const empty = (): UsagePart => ({ inputTokens: 0, outputTokens: 0, cost: 0, cachedTokens: 0, calls: 0 });
const open = new Map<string, ReplyUsage>();

/** A reply starts: count its calls from now. */
export function startReply(id: string): void {
	open.set(id, { main: empty(), subagents: empty() });
}

/**
 * Adds a finished model call to the task's open reply. The reviewer, the one
 * other agent working under a task's id, has replies of its own; a subagent's
 * calls count whatever name they carry. Runs in the event observer, synchronously.
 */
export function countReplyCall(event: TurnEvent): void {
	if (event.type !== 'turn' || !event.instanceId || !event.response?.usage) return;
	if (event.agentName && /^reviewer$/i.test(event.agentName)) return;
	const reply = open.get(event.instanceId);
	if (!reply) return;
	const usage = toUsage(event.response.usage);
	const part = !event.taskId && (event.session === undefined || event.session === 'default') ? reply.main : reply.subagents;
	part.inputTokens += usage.inputTokens;
	part.outputTokens += usage.outputTokens;
	part.cost += usage.cost;
	part.cachedTokens = (part.cachedTokens ?? 0) + (usage.cachedTokens ?? 0);
	part.calls += 1;
}

/** The reply's calls, ending the count; null when its start was not seen (a reply resumed after a restart). */
export function finishReply(id: string): ReplyUsage | null {
	const reply = open.get(id) ?? null;
	open.delete(id);
	return reply && reply.main.calls + reply.subagents.calls > 0 ? reply : null;
}

/** Both parts together, as the reply's usage. */
export function replyTotal({ main, subagents }: ReplyUsage): Usage {
	return {
		inputTokens: main.inputTokens + subagents.inputTokens,
		outputTokens: main.outputTokens + subagents.outputTokens,
		cost: main.cost + subagents.cost,
		cachedTokens: (main.cachedTokens ?? 0) + (subagents.cachedTokens ?? 0),
	};
}
