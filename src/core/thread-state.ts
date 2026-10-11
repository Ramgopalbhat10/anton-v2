import type { Session } from './types.ts';

/**
 * Where a project's thread stands, in the order the project shows them:
 * what needs you first, then what runs, waits for a slot, waits on review,
 * is about to land, sits idle, and what is done.
 */
export const THREAD_STATES = ['waiting', 'working', 'queued', 'review', 'landing', 'idle', 'resolved'] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export const THREAD_STATE_LABELS: Record<ThreadState, string> = {
	waiting: 'Waiting on you',
	working: 'Working',
	queued: 'Queued',
	review: 'Ready for review',
	landing: 'Landing',
	idle: 'Idle',
	resolved: 'Resolved',
};

type Facts = Pick<Session, 'working' | 'status' | 'asking' | 'planMode' | 'usage' | 'pullRequest' | 'prUrl' | 'resolvedAt' | 'brief'>;

/** The agent proposed a plan and changes nothing until it is approved. */
const planReady = (thread: Facts) => thread.planMode && !thread.working && thread.usage.outputTokens > 0;

/**
 * One thread's state from the task's own fields; the first rule that holds
 * wins. The server reports and counts with it and the page shows it, so the
 * two never disagree. Nothing here is stored.
 */
export function threadState(thread: Facts): ThreadState {
	if (thread.resolvedAt) return 'resolved';
	const pr = thread.prUrl ? thread.pullRequest : null;
	if (thread.working || thread.status === 'starting') return 'working';
	if (thread.status === 'error' || thread.asking || planReady(thread) || pr?.checks === 'failed') return 'waiting';
	if (thread.brief) return 'queued';
	if (pr && (pr.state === 'open' || pr.state === 'draft')) return pr.approved && pr.state === 'open' ? 'landing' : 'review';
	return 'idle';
}

/** Whether the thread needs something from you: an answer, an approval, or a look at what failed. */
export const needsYou = (state: ThreadState) => state === 'waiting';

/** Threads that hold a slot of the project's parallel limit. */
export const holdsSlot = (state: ThreadState) => state === 'working';
