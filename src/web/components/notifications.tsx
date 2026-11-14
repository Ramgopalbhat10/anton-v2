import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { memo, useEffect } from 'react';
import { IconBtn } from '@/components/signal';
import { api, type NotificationCategory, type NotificationsView, SAFETY_NET_MS } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * The bell beside the sidebar toggle and the Inbox page it opens: the moments
 * in your tasks worth a look (src/services/notifications.ts), not every step.
 * The list updates from server events; opening a task reads its rows.
 */

/** The filters, in the order they matter: what waits on you first, what went wrong, what finished, what was said, and the machines. */
export const CATEGORIES: Array<{ id: NotificationCategory; label: string }> = [
	{ id: 'needs-you', label: 'Needs you' },
	{ id: 'failures', label: 'Failures' },
	{ id: 'done', label: 'Done' },
	{ id: 'replies', label: 'Replies' },
	{ id: 'sandboxes', label: 'Sandboxes' },
];

/** Sandboxes starting and stopping are for looking up, not for calling you over: the bell's count leaves them out. */
const QUIET: NotificationCategory[] = ['sandboxes'];

export function useNotifications() {
	return useQuery({ queryKey: ['notifications'], queryFn: api.notifications, refetchInterval: SAFETY_NET_MS });
}

/** Unread rows that call you over: everything but sandboxes starting and stopping. */
export const loudUnread = (unread: NotificationsView['unread'] | undefined) =>
	unread ? CATEGORIES.filter((category) => !QUIET.includes(category.id)).reduce((sum, category) => sum + (unread[category.id] ?? 0), 0) : 0;

/** The bell: a count of unread rows, amber while something waits on you and red when something failed. */
export function NotificationsBell({ onOpen, size = 'xs', className }: { onOpen: () => void; size?: 'xs' | 'sm'; className?: string }) {
	const { data } = useNotifications();
	const count = loudUnread(data?.unread);
	// An answer from an older server may carry no counts; the bell then shows none rather than taking the page down.
	const tone = data?.unread?.failures ? 'bg-(--bad)' : data?.unread?.['needs-you'] ? 'bg-(--warn)' : 'bg-(--accent)';
	return (
		<span className={cn('relative inline-flex shrink-0', className)}>
			<IconBtn icon={Bell} size={size} label={count ? `Notifications, ${count} unread` : 'Notifications'} onClick={onOpen} />
			{count ? (
				<span
					aria-hidden
					className={cn(
						'pointer-events-none absolute -top-1 -right-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-[3px] text-nano leading-none font-semibold text-(--bg-app) tabular-nums shadow-[0_0_0_2px_var(--bg-panel)]',
						tone,
					)}
				>
					{count > 99 ? '99+' : count}
				</span>
			) : null}
		</span>
	);
}

/** Opening a task reads its rows, and a row that arrives while you look at it is read at once. A component of its own, so the list changing never re-renders the task. */
/** Marks a task's notifications read while you look at it. Memoized: the task page around it draws on every chunk of a reply. */
export const ReadNotificationsOf = memo(function ReadNotificationsOf({ sessionId }: { sessionId: string }): null {
	const queryClient = useQueryClient();
	const { data } = useNotifications();
	const unread = data?.notifications.some((notification) => notification.sessionId === sessionId && !notification.read) ?? false;
	useEffect(() => {
		if (!unread || document.hidden) return;
		void api.readNotifications({ sessionId }).then((view) => queryClient.setQueryData(['notifications'], view)).catch(() => undefined);
	}, [unread, sessionId, queryClient]);
	// A row that came while the tab was in the background is read once you come back to it.
	useEffect(() => {
		if (!unread) return;
		const onVisible = () => {
			if (!document.hidden) void api.readNotifications({ sessionId }).then((view) => queryClient.setQueryData(['notifications'], view)).catch(() => undefined);
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	}, [unread, sessionId, queryClient]);
	return null;
});
