import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { Session } from '@/lib/api/sessions';

/** A delete that failed: the task is back in its lists, and this says why. */
export type FailedDeletion = { id: string; title: string; error: string };

/** Hidden from every list at once; `true` once the server answered, so the id is let go when the server stops listing it. */
const hidden = new Map<string, boolean>();
const failures = new Map<string, FailedDeletion>();
let shown: FailedDeletion[] = [];
const listeners = new Set<() => void>();

/** The server answers a slow delete before it is finished; one that then failed shows again after this, rather than stay hidden for good. */
const HIDDEN_AFTER_ANSWER_MS = 5 * 60_000;

function changed() {
	shown = [...failures.values()];
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

export function useFailedDeletions(): FailedDeletion[] {
	return useSyncExternalStore(subscribe, () => shown);
}

export function dismissFailure(id: string) {
	if (failures.delete(id)) changed();
}

/** A server's list of tasks without those this page is deleting, which it lists until its delete finishes. */
export function withoutDeleting(sessions: Session[]): Session[] {
	if (!hidden.size) return sessions;
	const listed = new Set(sessions.map((session) => session.id));
	for (const [id, answered] of hidden) if (answered && !listed.has(id)) hidden.delete(id);
	return sessions.filter((session) => !hidden.has(session.id));
}

type List = { sessions: Session[] };

/**
 * Deletes a task or thread with no wait: it leaves every list now, as a rename or a pin shows at once, while the server stops its sandbox and keeps its files.
 * A delete that fails puts it back where it was and says why.
 */
export function deleteInBackground(queryClient: QueryClient, session: Session, remove: () => Promise<void>): void {
	const { id } = session;
	if (hidden.has(id)) return;
	hidden.set(id, false);
	if (failures.delete(id)) changed();
	const before = queryClient.getQueryData<List>(['sessions'])?.sessions ?? [];
	const at = before.findIndex((item) => item.id === id);
	const removed = at >= 0 ? before[at] : session;
	queryClient.setQueryData<List>(['sessions'], (data) => (data ? { ...data, sessions: data.sessions.filter((item) => item.id !== id) } : data));
	remove().then(
		() => {
			hidden.set(id, true);
			setTimeout(() => hidden.delete(id), HIDDEN_AFTER_ANSWER_MS);
			queryClient.removeQueries({ queryKey: ['session', id], exact: true });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			// Its files show in the project's Library, in a folder named for it.
			if (session.spaceId) {
				void queryClient.invalidateQueries({ queryKey: ['space-files', session.spaceId] });
				void queryClient.invalidateQueries({ queryKey: ['spaces'] });
			}
		},
		(error: unknown) => {
			hidden.delete(id);
			failures.set(id, { id, title: session.title, error: error instanceof Error ? error.message : String(error) });
			changed();
			queryClient.setQueryData<List>(['sessions'], (data) => {
				if (!data || data.sessions.some((item) => item.id === id)) return data;
				const sessions = [...data.sessions];
				sessions.splice(at >= 0 ? Math.min(at, sessions.length) : 0, 0, removed);
				return { ...data, sessions };
			});
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
	);
}
