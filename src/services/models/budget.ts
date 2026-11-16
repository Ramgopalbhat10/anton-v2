import { getSessionRecord, spentSince } from '../../db/sessions.ts';
import { getSetting, setSetting } from '../../db/settings.ts';
import { isWorking, stopAgent } from '../tasks/activity.ts';
import { notifyBudgetStop } from '../notify/notifications.ts';

export type Limits = { dailyUsd: number | null; taskUsd: number | null };

/** A daily cap from the start, so a runaway loop or automation cannot spend without bound. */
export const DEFAULT_LIMITS: Limits = { dailyUsd: 10, taskUsd: null };

export type Budget = {
	limits: Limits;
	today: number;
	task: number | null;
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

export async function budget(sessionId?: string, now = new Date()): Promise<Budget> {
	const [caps, today, record] = await Promise.all([limits(), spentSince(startOfToday(now)), sessionId ? getSessionRecord(sessionId) : null]);
	const task = record?.usage.cost ?? null;
	return { limits: caps, today, task, blocked: reason(caps, today, task) };
}

export async function assertWithinBudget(sessionId: string): Promise<void> {
	const { blocked } = await budget(sessionId);
	if (blocked) throw new BudgetError(blocked);
}

/** So a runaway loop ends at its next model call rather than when it finishes. */
export async function stopIfOverBudget(sessionId: string): Promise<void> {
	const { blocked } = await budget(sessionId);
	if (!blocked) return;
	// Only the reply it stops is news; later checks find nothing working.
	if (isWorking(sessionId)) notifyBudgetStop(sessionId, blocked);
	await stopAgent(sessionId);
}
