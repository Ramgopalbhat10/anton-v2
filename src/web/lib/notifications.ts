import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api, SAFETY_NET_MS, type Session } from '@/lib/api';
import { serviceWorker, turnOnIfAllowed } from '@/lib/push';

const supported = () => typeof Notification !== 'undefined';

/**
 * Asks once, from a click or keypress, since browsers ignore requests made without one.
 * Allowing it also turns on notifications for when no tab is open.
 */
export function askToNotify(): void {
	if (supported() && Notification.permission === 'default') void Notification.requestPermission().then(() => turnOnIfAllowed()).catch(() => undefined);
}

/** Where a task's notification opens it: a project's thread inside its project, as pushed notifications do. */
export const taskPath = (session: Pick<Session, 'id' | 'spaceId'>) => (session.spaceId ? `/projects/${session.spaceId}/threads/${session.id}` : `/agents/${session.id}`);

async function notify(session: Session): Promise<void> {
	const failed = session.status === 'error';
	// The same words and tag as a pushed notice, so one for the same task replaces the other rather than showing twice.
	const body = failed ? `Failed: ${session.errorMessage ?? 'the task stopped with an error.'}` : session.asking ? session.asking : session.planMode && session.plan ? 'Plan ready. Approve it or ask for changes.' : 'Finished.';
	const options = { body, tag: `anton-${session.id}`, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { url: taskPath(session) } };
	// Phones show notifications only through the service worker, which opens the task when one is tapped.
	const registration = await serviceWorker();
	if (registration) return void (await registration.showNotification(session.title, options));
	const notification = new Notification(session.title, options);
	notification.onclick = () => {
		window.focus();
		window.location.assign(taskPath(session));
	};
}

/**
 * A notification when a task's agent stops working while you are looking at
 * another tab or window. Uses the same list as the sidebar.
 */
export function useTaskNotifications(): void {
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: SAFETY_NET_MS });
	const wasWorking = useRef(new Set<string>());

	useEffect(() => {
		const list = sessions.data?.sessions;
		if (!list) return;
		const finished = list.filter((session) => wasWorking.current.has(session.id) && !session.working);
		wasWorking.current = new Set(list.filter((session) => session.working).map((session) => session.id));
		if (!supported() || Notification.permission !== 'granted' || !document.hidden) return;
		for (const session of finished) void notify(session).catch(() => undefined);
	}, [sessions.data]);
}
