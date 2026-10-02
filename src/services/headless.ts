import { runDueAutomations } from './automations.ts';
import { runFollowUps } from './follow-ups.ts';

/** How often Anton looks for labeled issues, due schedules and news on its pull requests. */
const POLL_MS = 5 * 60_000;

/** Work that starts without anyone typing. Polling, since a personal server has no public URL for webhooks. */
export function scheduleHeadlessWork(): void {
	const tick = async () => {
		await runDueAutomations().catch((error: unknown) => console.warn('[anton] automations failed', error));
		await runFollowUps().catch((error: unknown) => console.warn('[anton] follow-ups failed', error));
	};
	setTimeout(() => void tick(), 30_000).unref();
	setInterval(() => void tick(), POLL_MS).unref();
}
