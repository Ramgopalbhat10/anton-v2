import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PullRequestActivity } from '../../core/ports.ts';
import { getSessionRecord, listSessionRecords } from '../../db/sessions.ts';
import { onIdle } from '../tasks/activity.ts';
import { budget } from '../models/budget.ts';
import { followUp } from './follow-ups.ts';
import { logProblem } from '../../core/log.ts';
import { finished, readPullRequest } from './pr-status.ts';
import { runAutomaticReviews } from './review-tasks.ts';

/** GitHub answers an unchanged read with a 304 that costs nothing from the rate limit, so this can be quick. */
export const WATCH_EVERY_MS = 15_000;
const WATCH_MS = 45 * 60_000;
/** Then the repository is taken to run no CI. */
const NO_CHECKS_MS = 3 * 60_000;
/** Reads asked for together (a burst of webhook deliveries, a turn ending) become one. */
const SETTLE_MS = 2_000;

const watched = new Map<string, { since: number; until: number }>();

export function watchPullRequest(id: string, now = Date.now()): void {
	watched.set(id, { since: now, until: now + WATCH_MS });
}

export const isWatched = (id: string) => watched.has(id);

function stillRunning(activity: PullRequestActivity, watch: { since: number; until: number } | undefined, now: number): boolean {
	if (!watch || now > watch.until) return false;
	if (activity.state !== 'open' && activity.state !== 'draft') return false;
	const checks = activity.checks.filter((check) => check.status !== 'skipped');
	if (checks.some((check) => check.status === 'pending')) return true;
	return checks.length === 0 && now - watch.since < NO_CHECKS_MS;
}

const checking = new Set<string>();
const soon = new Map<string, ReturnType<typeof setTimeout>>();

export async function checkPullRequest(id: string, now = Date.now()): Promise<void> {
	if (checking.has(id)) {
		checkPullRequestSoon(id);
		return;
	}
	checking.add(id);
	try {
		const session = await getSessionRecord(id);
		if (!session?.prUrl || finished(session)) {
			watched.delete(id);
			return;
		}
		const activity = await readPullRequest({ ...session, prUrl: session.prUrl });
		if (!(await budget()).blocked) await followUp(session, activity);
		if (!stillRunning(activity, watched.get(id), now)) watched.delete(id);
	} finally {
		checking.delete(id);
	}
}

export function checkPullRequestSoon(id: string, delay = SETTLE_MS): void {
	if (soon.has(id)) return;
	const timer = setTimeout(() => {
		soon.delete(id);
		checkPullRequest(id).catch((error: unknown) => logProblem('warn', 'Could not check the pull request', error, id));
	}, delay);
	timer.unref?.();
	soon.set(id, timer);
}

export async function readWatchedPullRequests(now = Date.now()): Promise<void> {
	for (const id of [...watched.keys()]) {
		await checkPullRequest(id, now).catch((error: unknown) => logProblem('warn', 'Could not check the pull request', error, id));
	}
}

export async function watchRunningChecks(now = Date.now()): Promise<void> {
	for (const session of await listSessionRecords()) {
		if (session.prUrl && session.pullRequest?.checks === 'pending' && !watched.has(session.id)) watchPullRequest(session.id, now);
	}
}

/** A task's pull request is also read as soon as its agent finishes, so what arrived while it worked reaches it then. */
export function scheduleWatchedPullRequests(): void {
	let busy = false;
	const tick = async () => {
		if (busy || watched.size === 0) return;
		busy = true;
		await readWatchedPullRequests().catch((error: unknown) => logProblem('warn', 'Reading watched pull requests failed', error));
		busy = false;
	};
	setInterval(() => void tick(), WATCH_EVERY_MS).unref();
	watchRunningChecks().catch((error: unknown) => logProblem('warn', 'Could not find running checks', error));
	onIdle((id) => {
		void getSessionRecord(id)
			.then((session) => {
				if (session?.prUrl && !finished(session)) checkPullRequestSoon(id);
			})
			.catch(() => undefined);
	});
}

export function signedByGitHub(secret: string, body: string, signature: string | undefined): boolean {
	if (!secret || !signature?.startsWith('sha256=')) return false;
	const expected = createHmac('sha256', secret).update(body).digest();
	const given = Buffer.from(signature.slice('sha256='.length), 'hex');
	return given.length === expected.length && timingSafeEqual(given, expected);
}

type Numbered = { number?: number };
type Delivery = {
	action?: string;
	repository?: { full_name?: string };
	pull_request?: Numbered;
	issue?: Numbered & { pull_request?: unknown };
	check_run?: { pull_requests?: Numbered[] };
	check_suite?: { pull_requests?: Numbered[] };
};

const PULL_EVENTS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread', 'issue_comment', 'check_run', 'check_suite', 'status']);
const PUSHED = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

/** An empty list means any of them (a commit status names none). */
function numbersOf(event: string, delivery: Delivery): number[] {
	if (event === 'issue_comment') return delivery.issue?.pull_request && delivery.issue.number ? [delivery.issue.number] : [];
	if (event === 'check_run') return (delivery.check_run?.pull_requests ?? []).flatMap((pull) => (pull.number ? [pull.number] : []));
	if (event === 'check_suite') return (delivery.check_suite?.pull_requests ?? []).flatMap((pull) => (pull.number ? [pull.number] : []));
	return delivery.pull_request?.number ? [delivery.pull_request.number] : [];
}

let reviewTimer: ReturnType<typeof setTimeout> | null = null;

/** Each pull request is then read from GitHub with Anton's own token, so nothing in the payload reaches an agent. */
export async function gitHubDelivery(event: string, delivery: Delivery): Promise<number> {
	const repo = delivery.repository?.full_name?.toLowerCase();
	if (!PULL_EVENTS.has(event) || !repo) return 0;
	const numbers = numbersOf(event, delivery);
	// An issue comment on an issue, not a pull request.
	if (event === 'issue_comment' && numbers.length === 0) return 0;
	const prefix = `https://github.com/${repo}/pull/`;
	const tasks = (await listSessionRecords()).filter((session) => {
		const url = session.prUrl?.toLowerCase();
		if (!url?.startsWith(prefix) || finished(session)) return false;
		return numbers.length === 0 || numbers.includes(Number(url.slice(prefix.length)));
	});
	const pushed = event === 'pull_request' && PUSHED.has(delivery.action ?? '');
	for (const task of tasks) {
		if (pushed) watchPullRequest(task.id);
		checkPullRequestSoon(task.id);
	}
	// A teammate's push may want a review when Review every pull request is on for the repo.
	if (pushed && !reviewTimer) {
		reviewTimer = setTimeout(() => {
			reviewTimer = null;
			runAutomaticReviews().catch((error: unknown) => logProblem('warn', 'Automatic reviews failed', error));
		}, SETTLE_MS);
		reviewTimer.unref?.();
	}
	return tasks.length;
}
