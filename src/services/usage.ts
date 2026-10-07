import type { Usage } from '../core/types.ts';
import { addSessionUsage, type SpendRow, spendBy, spentSince } from '../db/sessions.ts';
import { startOfToday } from './budget.ts';
import { logProblem } from './log.ts';

/** What the runtime reports for one response; cached prompt tokens are still prompt tokens. */
type ResponseUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };

export function toUsage(usage: ResponseUsage): Usage {
	return { inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output, cost: usage.cost.total };
}

/** Adds usage to the task's totals, under the model that did the work; a failed write only loses the count. */
export async function recordUsage(id: string, usage: Usage, model: string | null = null, turnId: string | null = null): Promise<boolean> {
	return addSessionUsage(id, usage, new Date(), model, turnId).catch((error: unknown) => {
		logProblem('warn', 'Usage not recorded', error, id);
		return false;
	});
}

type TurnEvent = {
	type: string;
	instanceId?: string;
	turnId?: string;
	request?: { providerId: string; requestedModel: string };
	response?: { usage?: ResponseUsage };
};

/** `openrouter/<id>`, the way tasks name their model, so a subagent on another model is counted under it. */
const modelOf = (request: TurnEvent['request']) => (request ? `${request.providerId}/${request.requestedModel}` : null);

/**
 * Counts every model call as it ends: the agent's, its subagents' and
 * compaction's, including calls in a response that is later stopped or fails.
 * Returns the task it counted against, if any.
 */
export async function recordTurnUsage(event: TurnEvent): Promise<string | null> {
	if (event.type !== 'turn' || !event.instanceId || !event.response?.usage) return null;
	const recorded = await recordUsage(event.instanceId, toUsage(event.response.usage), modelOf(event.request), event.turnId ?? null);
	return recorded ? event.instanceId : null;
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
