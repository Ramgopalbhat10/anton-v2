import type { PullRequestActivity } from '../core/ports.ts';
import { listSessionRecords } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';

/** Where a pull request stands for its reviewer: you, its checks, or done. */
export type ReviewGroup = 'failing' | 'checking' | 'ready' | 'merged' | 'closed' | 'unknown';

export type ReviewItem = {
	sessionId: string;
	title: string;
	repo: string;
	url: string;
	group: ReviewGroup;
	draft: boolean;
	checks: { passed: number; failed: number; pending: number };
	comments: number;
	createdAt: string;
};

const ORDER: ReviewGroup[] = ['ready', 'failing', 'checking', 'unknown', 'merged', 'closed'];

function groupOf(activity: PullRequestActivity | null): ReviewGroup {
	if (!activity) return 'unknown';
	if (activity.state === 'merged' || activity.state === 'closed') return activity.state;
	if (activity.checks.some((check) => check.status === 'failed')) return 'failing';
	return activity.checks.some((check) => check.status === 'pending') ? 'checking' : 'ready';
}

const count = (activity: PullRequestActivity | null, status: string) => activity?.checks.filter((check) => check.status === status).length ?? 0;

/**
 * Pull request state lives on the host, which announces nothing to Anton, so
 * the queue asks it and keeps answers briefly; a merged or closed one never
 * changes again and is kept for good.
 */
const cache = new Map<string, { at: number; activity: PullRequestActivity }>();
const FRESH_MS = 60_000;

async function activityOf(url: string): Promise<PullRequestActivity | null> {
	const hit = cache.get(url);
	const final = hit && (hit.activity.state === 'merged' || hit.activity.state === 'closed');
	if (hit && (final || Date.now() - hit.at < FRESH_MS)) return hit.activity;
	try {
		const activity = await getProviders().git.pullRequestActivity(url);
		cache.set(url, { at: Date.now(), activity });
		return activity;
	} catch {
		return hit?.activity ?? null;
	}
}

/** Every pull request the agent opened, the ones waiting on you first. */
export async function reviewQueue(): Promise<ReviewItem[]> {
	const sessions = (await listSessionRecords()).filter((session) => session.prUrl);
	const items = await Promise.all(
		sessions.map(async (session): Promise<ReviewItem> => {
			const url = session.prUrl as string;
			const activity = await activityOf(url);
			return {
				sessionId: session.id,
				title: session.title,
				repo: session.repo,
				url,
				group: groupOf(activity),
				draft: activity?.state === 'draft',
				checks: { passed: count(activity, 'passed'), failed: count(activity, 'failed'), pending: count(activity, 'pending') },
				comments: activity?.comments.length ?? 0,
				createdAt: session.createdAt,
			};
		}),
	);
	// Sessions come newest first, and a stable sort keeps that order within each group.
	return items.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
}
