import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api, type Session } from '@/lib/api';

const supported = () => typeof Notification !== 'undefined';

/** Asks once, from a click or keypress, since browsers ignore requests made without one. */
export function askToNotify(): void {
	if (supported() && Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined);
}

function notify(session: Session): void {
	const failed = session.status === 'error';
	const notification = new Notification(failed ? 'Task failed' : 'Task finished', {
		body: session.title,
		tag: `anton-${session.id}`,
	});
	notification.onclick = () => {
		window.focus();
		window.location.assign(`/agents/${session.id}?app=code`);
	};
}

/**
 * A desktop notification when a task's agent stops working while you are
 * looking at another tab or window. Uses the same poll as the sidebar.
 */
export function useTaskNotifications(): void {
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 5000 });
	const wasWorking = useRef(new Set<string>());

	useEffect(() => {
		const list = sessions.data?.sessions;
		if (!list) return;
		const finished = list.filter((session) => wasWorking.current.has(session.id) && !session.working);
		wasWorking.current = new Set(list.filter((session) => session.working).map((session) => session.id));
		if (!supported() || Notification.permission !== 'granted' || !document.hidden) return;
		finished.forEach(notify);
	}, [sessions.data]);
}
