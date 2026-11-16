import type { Usage } from '../../core/types.ts';
import { unrouted } from '../../core/model-route.ts';
import { addSessionUsage, type SpendRow, spendBy, spendByMinute, spentSince } from '../../db/sessions.ts';
import { startOfToday } from './budget.ts';
import { logProblem } from '../../core/log.ts';
import { type PlanUsage, planUsage } from './subscriptions.ts';

/** Cached prompt tokens are still prompt tokens. */
type ResponseUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };

export function toUsage(usage: ResponseUsage): Usage {
	return { inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output, cost: usage.cost.total, cachedTokens: usage.cacheRead };
}

export function addUsage(a: Usage, b: Usage): Usage {
	return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cost: a.cost + b.cost, cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0) };
}

export async function recordUsage(id: string, usage: Usage, model: string | null = null, turnId: string | null = null): Promise<boolean> {
	return addSessionUsage(id, usage, new Date(), model ? unrouted(model) : null, turnId).catch((error: unknown) => {
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

/** A task's route is no model of its own: its calls count under the model. */
const modelOf = (request: TurnEvent['request']) => (request ? unrouted(`${request.providerId}/${request.requestedModel}`) : null);

/** Includes calls in a response that is later stopped or fails. Returns the task it counted against, if any. */
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

export const DAILY_DAYS = 30;

export type DailySpend = { day: string; model: string | null; tokens: number; cost: number };

/** The way the daily cap counts days. */
export function dayKey(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function dailySpend(now: Date): Promise<DailySpend[]> {
	const since = startOfToday(now);
	since.setDate(since.getDate() - (DAILY_DAYS - 1));
	const rows = new Map<string, DailySpend>();
	for (const row of await spendByMinute(since)) {
		const day = dayKey(new Date(`${row.minute}:00Z`));
		const key = `${day} ${row.model ?? ''}`;
		const entry = rows.get(key) ?? { day, model: row.model, tokens: 0, cost: 0 };
		entry.tokens += row.tokens;
		entry.cost += row.cost;
		rows.set(key, entry);
	}
	return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export type UsageView = { since: string; today: number; month: number; byRepo: SpendRow[]; byModel: SpendRow[]; daily: DailySpend[]; plans: PlanUsage[] };

export async function usageView(now = new Date()): Promise<UsageView> {
	const since = startOfMonth(now);
	const [today, month, byRepo, byModel, daily, plans] = await Promise.all([
		spentSince(startOfToday(now)),
		spentSince(since),
		spendBy('repo', since),
		spendBy('model', since),
		dailySpend(now),
		planUsage(now),
	]);
	return { since: since.toISOString(), today, month, byRepo, byModel, daily, plans };
}
