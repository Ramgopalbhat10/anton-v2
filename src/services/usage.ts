import type { Usage } from '../core/types.ts';
import { addSessionUsage } from '../db/sessions.ts';

/** What the runtime reports for one response; cached prompt tokens are still prompt tokens. */
type ResponseUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };

export function toUsage(usage: ResponseUsage): Usage {
	return { inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output, cost: usage.cost.total };
}

/** Adds usage to the task's totals; a failed write only loses the count. */
export async function recordUsage(id: string, usage: Usage): Promise<void> {
	await addSessionUsage(id, usage).catch((error: unknown) => console.warn('[anton] usage not recorded', error));
}

type TurnEvent = { type: string; instanceId?: string; response?: { usage?: ResponseUsage } };

/**
 * Counts every model call as it ends: the agent's, its subagents' and
 * compaction's, including calls in a response that is later stopped or fails.
 * Returns the task it counted against, if any.
 */
export async function recordTurnUsage(event: TurnEvent): Promise<string | null> {
	if (event.type !== 'turn' || !event.instanceId || !event.response?.usage) return null;
	await recordUsage(event.instanceId, toUsage(event.response.usage));
	return event.instanceId;
}
