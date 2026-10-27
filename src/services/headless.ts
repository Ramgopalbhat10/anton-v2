import { runDueAutomations } from './automations.ts';
import { runFollowUps } from './follow-ups.ts';
import { logProblem } from './log.ts';
import { refreshPullRequests } from './pr-status.ts';
import { scheduleWatchedPullRequests, watchRunningChecks } from './pr-watch.ts';
import { runAutomaticReviews } from './review-tasks.ts';
import { resolveIdleThreads } from './thread-reports.ts';

/**
 * How often Anton looks for labeled issues, news on its pull requests and pull requests to review.
 * A pull request whose checks run is read far more often (`pr-watch.ts`), and a GitHub webhook,
 * when set up, has it read the moment anything happens; this round is the safety net under both.
 */
const POLL_MS = 5 * 60_000;
/** How often it looks for scheduled routines that are due, so each starts within a minute of its time. */
const SCHEDULE_MS = 60_000;

/** Work that starts without anyone typing. Mostly polling, since a personal server often has no public URL for webhooks. */
export function scheduleHeadlessWork(): void {
	// A slow round (many pull requests, a slow GitHub) is never overlapped by the next one.
	let busy = false;
	const tick = async () => {
		if (busy) return;
		busy = true;
		await runDueAutomations(undefined, 'issues').catch((error: unknown) => logProblem('warn', 'Automations failed', error));
		await runFollowUps().catch((error: unknown) => logProblem('warn', 'Follow-ups failed', error));
		await runAutomaticReviews().catch((error: unknown) => logProblem('warn', 'Automatic reviews failed', error));
		// After follow-ups, which read most of the same pull requests already.
		await refreshPullRequests().catch((error: unknown) => logProblem('warn', 'Reading pull requests failed', error));
		// Checks someone else's push started, which the round just found, are then followed closely.
		await watchRunningChecks().catch((error: unknown) => logProblem('warn', 'Could not find running checks', error));
		await resolveIdleThreads().catch((error: unknown) => logProblem('warn', 'Resolving idle threads failed', error));
		busy = false;
	};
	setTimeout(() => void tick(), 30_000).unref();
	setInterval(() => void tick(), POLL_MS).unref();
	scheduleWatchedPullRequests();

	// Schedules only read the database until one is due, so they are looked at every minute, apart from the slow round.
	let checking = false;
	const due = async () => {
		if (checking) return;
		checking = true;
		await runDueAutomations(undefined, 'schedule').catch((error: unknown) => logProblem('warn', 'Routines failed', error));
		checking = false;
	};
	setTimeout(() => void due(), 30_000).unref();
	setInterval(() => void due(), SCHEDULE_MS).unref();
}
