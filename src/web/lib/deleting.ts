import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { Session } from '@/lib/api/sessions';

/** A delete you asked for in this page, as its notice shows it. */
export type Deletion = { id: string; title: string; thread: boolean; state: 'deleting' | 'deleted' | 'failed'; error: string | null };

/** Hidden from every list at once; `true` once the server answered, so the id is let go when the server stops listing it. */
const hidden = new Map<string, boolean>();
const notices = new Map<string, Deletion>();
let shown: Deletion[] = [];
const listeners = new Set<() => void>();

const DONE_SHOWN_MS = 4_000;
/** The server answers a slow delete before it is finished; one that then failed shows again after this, rather than stay hidden for good. */
const HIDDEN_AFTER_ANSWER_MS = 5 * 60_000;

function changed() {
	shown = [...notices.values()];
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

export function useDeletions(): Deletion[] {
	return useSyncExternalStore(subscribe, () => shown);
}

export function dismissDeletion(id: string) {
	if (notices.delete(id)) changed();
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
 * Deletes a task or thread with no wait: it leaves every list now, and a notice follows the delete, which stops its sandbox and keeps its files first.
 * A delete that fails puts it back where it was and says why.
 */
export function deleteInBackground(queryClient: QueryClient, session: Session, remove: () => Promise<void>): void {
	const { id } = session;
	if (hidden.has(id)) return;
	const thread = Boolean(session.spaceId);
	hidden.set(id, false);
	notices.set(id, { id, title: session.title, thread, state: 'deleting', error: null });
	changed();
	const before = queryClient.getQueryData<List>(['sessions'])?.sessions ?? [];
	const at = before.findIndex((item) => item.id === id);
	const removed = at >= 0 ? before[at] : session;
	queryClient.setQueryData<List>(['sessions'], (data) => (data ? { ...data, sessions: data.sessions.filter((item) => item.id !== id) } : data));
	remove().then(
		() => {
			hidden.set(id, true);
			setTimeout(() => hidden.delete(id), HIDDEN_AFTER_ANSWER_MS);
			notices.set(id, { id, title: session.title, thread, state: 'deleted', error: null });
			changed();
			setTimeout(() => {
				if (notices.get(id)?.state === 'deleted') dismissDeletion(id);
			}, DONE_SHOWN_MS);
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
			notices.set(id, { id, title: session.title, thread, state: 'failed', error: error instanceof Error ? error.message : String(error) });
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
