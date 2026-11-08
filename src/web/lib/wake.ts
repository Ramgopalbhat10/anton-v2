import { useCallback, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { newTaskId } from '@/lib/starting';

/** How often a draft asks again for its sandbox while it has text; the server lets one go after two minutes without. */
const HEARTBEAT_MS = 30_000;

/**
 * While a new task's prompt has text, a sandbox for it starts on the server, under the id the task will be made
 * with, so it is set up by the time the task is sent. It is asked for again while the text stays and the page is in
 * view, and let go when the text is cleared, the repo or branch changes, or the page goes. Returns what to call for
 * the new task's id: the woken one when there is one, so the task finds its sandbox, else a new one.
 */
export function useDraftWake({ projectId, branch, typed, enabled }: { projectId?: string; branch?: string; typed: boolean; enabled: boolean }): () => string {
	const draft = useRef<string | null>(null);
	const taken = useRef<string | null>(null);
	const active = Boolean(enabled && typed && projectId);
	useEffect(() => {
		if (!active || !projectId) return;
		let id = newTaskId();
		draft.current = id;
		let woke = false;
		const ask = () => {
			if (document.visibilityState === 'hidden') return;
			api.wakeDraft(projectId, id, branch)
				.then(({ waking }) => {
					// Let go on the server (the page was away too long): wake again under a new id, once.
					if (!waking && woke && draft.current === id) {
						woke = false;
						id = newTaskId();
						draft.current = id;
						ask();
						return;
					}
					woke = waking;
				})
				.catch(() => undefined);
		};
		ask();
		const timer = window.setInterval(ask, HEARTBEAT_MS);
		document.addEventListener('visibilitychange', ask);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener('visibilitychange', ask);
			if (taken.current !== id) void api.releaseDraft(id).catch(() => undefined);
			if (draft.current === id) draft.current = null;
		};
	}, [active, projectId, branch]);
	return useCallback(() => {
		const id = draft.current ?? newTaskId();
		taken.current = id;
		return id;
	}, []);
}

/** At most one wake per this while a message to a task is typed: the server keeps a started machine up its idle minutes. */
const SESSION_WAKE_MS = 60_000;

/**
 * Starts a stopped task's sandbox as a message to it is typed, so the machine is up, or nearly, when it is sent. The
 * server decides whether the task is one that needs it.
 */
export function useSessionWake(sessionId: string, typed: boolean, stopped: boolean): void {
	const last = useRef(0);
	useEffect(() => {
		if (!typed || !stopped || Date.now() - last.current < SESSION_WAKE_MS) return;
		last.current = Date.now();
		void api.wakeSession(sessionId).catch(() => undefined);
	}, [sessionId, typed, stopped]);
}
