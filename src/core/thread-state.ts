import type { Session } from './types.ts';

/** In the order a project shows them. */
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

type Facts = Pick<Session, 'working' | 'status' | 'asking' | 'planMode' | 'plan' | 'pullRequest' | 'prUrl' | 'resolvedAt' | 'brief' | 'stoppedAt'>;

const planReady = (thread: Facts) => thread.planMode && !thread.working && Boolean(thread.plan);

/** The first rule that holds wins. The server and every page use it, so none disagree. */
export function threadState(thread: Facts): ThreadState {
	if (thread.resolvedAt) return 'resolved';
	const pr = thread.prUrl ? thread.pullRequest : null;
	if (thread.working || thread.status === 'starting') return 'working';
	// A reply the user stopped partway leaves the next move to them, whatever it got done.
	if (thread.status === 'error' || thread.stoppedAt || thread.asking || planReady(thread) || pr?.checks === 'failed') return 'waiting';
	if (thread.brief) return 'queued';
	if (pr && (pr.state === 'open' || pr.state === 'draft')) return pr.approved && pr.state === 'open' ? 'landing' : 'review';
	return 'idle';
}

export const needsYou = (state: ThreadState) => state === 'waiting';

export const holdsSlot = (state: ThreadState) => state === 'working';
