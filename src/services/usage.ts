import type { Usage } from '../core/types.ts';
import { addSessionUsage, type SpendRow, spendBy, spentSince } from '../db/sessions.ts';
import { startOfToday } from './budget.ts';
import { logProblem } from './log.ts';

/** What the runtime reports for one response; cached prompt tokens are still prompt tokens. */
type ResponseUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };

export function toUsage(usage: ResponseUsage): Usage {
	return { inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output, cost: usage.cost.total };
}

/** Adds usage to the task's totals; a failed write only loses the count. */
export async function recordUsage(id: string, usage: Usage): Promise<void> {
	await addSessionUsage(id, usage).catch((error: unknown) => logProblem('warn', 'Usage not recorded', error, id));
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

function startOfMonth(now: Date): Date {
	const day = startOfToday(now);
	day.setDate(1);
	return day;
}

/** What has been spent this month, in total and by repository and model, from the server's local midnight on the 1st. */
export type UsageView = { since: string; today: number; month: number; byRepo: SpendRow[]; byModel: SpendRow[] };

export async function usageView(now = new Date()): Promise<UsageView> {
	const since = startOfMonth(now);
	const [today, month, byRepo, byModel] = await Promise.all([spentSince(startOfToday(now)), spentSince(since), spendBy('repo', since), spendBy('model', since)]);
	return { since: since.toISOString(), today, month, byRepo, byModel };
}
