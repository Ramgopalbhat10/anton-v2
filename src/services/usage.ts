import type { Usage } from '../core/types.ts';
import { addSessionUsage } from '../db/sessions.ts';

/** What the runtime reports for one response; cached prompt tokens are still prompt tokens. */
type ResponseUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };

export function toUsage(usage: ResponseUsage): Usage {
	return { inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output, cost: usage.cost.total };
}

/** Adds a finished response to the task's totals; a failed write only loses the count. */
export function recordUsage(id: string, usage: Usage): void {
	addSessionUsage(id, usage).catch((error: unknown) => console.warn('[anton] usage not recorded', error));
}
