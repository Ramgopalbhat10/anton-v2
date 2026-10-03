import { runDueAutomations } from './automations.ts';
import { runFollowUps } from './follow-ups.ts';
import { logProblem } from './log.ts';

/** How often Anton looks for labeled issues, due schedules and news on its pull requests. */
const POLL_MS = 5 * 60_000;

/** Work that starts without anyone typing. Polling, since a personal server has no public URL for webhooks. */
export function scheduleHeadlessWork(): void {
	// A slow round (many pull requests, a slow GitHub) is never overlapped by the next one.
	let busy = false;
	const tick = async () => {
		if (busy) return;
		busy = true;
		await runDueAutomations().catch((error: unknown) => logProblem('warn', 'Automations failed', error));
		await runFollowUps().catch((error: unknown) => logProblem('warn', 'Follow-ups failed', error));
		busy = false;
	};
	setTimeout(() => void tick(), 30_000).unref();
	setInterval(() => void tick(), POLL_MS).unref();
}
