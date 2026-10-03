import { getSessionRecord, spentSince } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { stopAgent } from './activity.ts';

/** Spending caps in US dollars; null means no cap. */
export type Limits = { dailyUsd: number | null; taskUsd: number | null };

/** A daily cap from the start, so a runaway loop or automation cannot spend without bound. */
export const DEFAULT_LIMITS: Limits = { dailyUsd: 10, taskUsd: null };

export type Budget = {
	limits: Limits;
	/** Spent since local midnight, across every task. */
	today: number;
	/** Spent by the task asked about, when one was. */
	task: number | null;
	/** Why new messages are refused right now, or null when they are not. */
	blocked: string | null;
};

export class BudgetError extends Error {
	readonly status = 429;
}

export const limits = () => getSetting<Limits>('limits', DEFAULT_LIMITS);
export const setLimits = (next: Limits) => setSetting('limits', next);

export function startOfToday(now: Date): Date {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	return day;
}

function reason(caps: Limits, today: number, task: number | null): string | null {
	if (caps.dailyUsd !== null && today >= caps.dailyUsd) return `Today's spending cap of $${caps.dailyUsd} is reached. Raise it in Settings to keep going.`;
	if (caps.taskUsd !== null && task !== null && task >= caps.taskUsd) return `This task's spending cap of $${caps.taskUsd} is reached. Raise it in Settings to keep going.`;
	return null;
}

/** What has been spent against the caps, today and by one task. */
export async function budget(sessionId?: string, now = new Date()): Promise<Budget> {
	const [caps, today, record] = await Promise.all([limits(), spentSince(startOfToday(now)), sessionId ? getSessionRecord(sessionId) : null]);
	const task = record?.usage.cost ?? null;
	return { limits: caps, today, task, blocked: reason(caps, today, task) };
}

/** Refuses a new message once a cap is reached. */
export async function assertWithinBudget(sessionId: string): Promise<void> {
	const { blocked } = await budget(sessionId);
	if (blocked) throw new BudgetError(blocked);
}

/** Stops a reply that has gone over a cap, so a runaway loop ends at its next model call rather than when it finishes. */
export async function stopIfOverBudget(sessionId: string): Promise<void> {
	if ((await budget(sessionId)).blocked) await stopAgent(sessionId);
}
