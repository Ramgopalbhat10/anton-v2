import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PullRequestActivity } from '../core/ports.ts';
import { getSessionRecord, listSessionRecords } from '../db/sessions.ts';
import { onIdle } from './activity.ts';
import { budget } from './budget.ts';
import { followUp } from './follow-ups.ts';
import { logProblem } from './log.ts';
import { finished, readPullRequest } from './pr-status.ts';
import { runAutomaticReviews } from './review-tasks.ts';

/**
 * How often a pull request whose checks are running is read. GitHub answers an
 * unchanged read with a 304 that costs nothing from the rate limit (see the
 * GitHub host), so this can be quick.
 */
export const WATCH_EVERY_MS = 15_000;
/** A pull request is read that often for at most this long after a push. */
const WATCH_MS = 45 * 60_000;
/** Checks that have not shown up this long after a push are taken as none: the repository runs no CI. */
const NO_CHECKS_MS = 3 * 60_000;
/** Reads asked for together (a burst of webhook deliveries, a turn ending) become one. */
const SETTLE_MS = 2_000;

/** Tasks whose pull request is read every WATCH_EVERY_MS, since when and until when. */
const watched = new Map<string, { since: number; until: number }>();

/** Reads the task's pull request often until its checks finish, so its card and follow-ups keep up with CI. */
export function watchPullRequest(id: string, now = Date.now()): void {
	watched.set(id, { since: now, until: now + WATCH_MS });
}

export const isWatched = (id: string) => watched.has(id);

/** Whether a watched pull request is still worth reading often: open, with checks running or not yet reported. */
function stillRunning(activity: PullRequestActivity, watch: { since: number; until: number } | undefined, now: number): boolean {
	if (!watch || now > watch.until) return false;
	if (activity.state !== 'open' && activity.state !== 'draft') return false;
	const checks = activity.checks.filter((check) => check.status !== 'skipped');
	if (checks.some((check) => check.status === 'pending')) return true;
	return checks.length === 0 && now - watch.since < NO_CHECKS_MS;
}

/** Tasks being read now, so a second ask waits for the first rather than racing it. */
const checking = new Set<string>();
const soon = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Reads the task's pull request, keeps its state and checks for the card, and
 * sends its agent anything new on it (failed checks, conflicts, comments) when
 * follow-ups are on and it is not working.
 */
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

/** Checks the task's pull request in a moment; asking again before then changes nothing. */
export function checkPullRequestSoon(id: string, delay = SETTLE_MS): void {
	if (soon.has(id)) return;
	const timer = setTimeout(() => {
		soon.delete(id);
		checkPullRequest(id).catch((error: unknown) => logProblem('warn', 'Could not check the pull request', error, id));
	}, delay);
	timer.unref?.();
	soon.set(id, timer);
}

/** Reads each watched pull request once, one after another. */
export async function readWatchedPullRequests(now = Date.now()): Promise<void> {
	for (const id of [...watched.keys()]) {
		await checkPullRequest(id, now).catch((error: unknown) => logProblem('warn', 'Could not check the pull request', error, id));
	}
}

/** Watches every open pull request last seen with checks running: after a restart, or one the slow round found. */
export async function watchRunningChecks(now = Date.now()): Promise<void> {
	for (const session of await listSessionRecords()) {
		if (session.prUrl && session.pullRequest?.checks === 'pending' && !watched.has(session.id)) watchPullRequest(session.id, now);
	}
}

/**
 * Reads watched pull requests every WATCH_EVERY_MS, and a task's pull request
 * as soon as its agent finishes, so failed checks or review findings that
 * arrived while it worked reach it then rather than on the next slow round.
 */
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

/** Whether a webhook delivery's body was signed with the shared secret, as GitHub's `X-Hub-Signature-256` says. */
export function signedByGitHub(secret: string, body: string, signature: string | undefined): boolean {
	if (!secret || !signature?.startsWith('sha256=')) return false;
	const expected = createHmac('sha256', secret).update(body).digest();
	const given = Buffer.from(signature.slice('sha256='.length), 'hex');
	return given.length === expected.length && timingSafeEqual(given, expected);
}

type Numbered = { number?: number };
/** The parts of a webhook payload Anton reads: which repository and which pull requests. Nothing else in it is used. */
type Delivery = {
	action?: string;
	repository?: { full_name?: string };
	pull_request?: Numbered;
	issue?: Numbered & { pull_request?: unknown };
	check_run?: { pull_requests?: Numbered[] };
	check_suite?: { pull_requests?: Numbered[] };
};

/** Events that can change a pull request's card or ask its agent for something. */
const PULL_EVENTS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread', 'issue_comment', 'check_run', 'check_suite', 'status']);
/** Pull request actions that move its head, for reviewing others' pull requests. */
const PUSHED = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

/** Which pull requests of the repository the delivery is about; an empty list means any of them (a commit status names none). */
function numbersOf(event: string, delivery: Delivery): number[] {
	if (event === 'issue_comment') return delivery.issue?.pull_request && delivery.issue.number ? [delivery.issue.number] : [];
	if (event === 'check_run') return (delivery.check_run?.pull_requests ?? []).flatMap((pull) => (pull.number ? [pull.number] : []));
	if (event === 'check_suite') return (delivery.check_suite?.pull_requests ?? []).flatMap((pull) => (pull.number ? [pull.number] : []));
	return delivery.pull_request?.number ? [delivery.pull_request.number] : [];
}

let reviewTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Acts on a webhook delivery from GitHub. It only says which pull requests to
 * read again: each is then read from GitHub with Anton's own token, as the
 * polling does, so nothing in the payload reaches an agent. Returns how many
 * tasks' pull requests it is checking.
 */
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
