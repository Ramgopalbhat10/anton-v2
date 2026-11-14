import { Link, useRouterState } from '@tanstack/react-router';
import { GitPullRequest, House, Inbox, ListTodo, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { loudUnread, useNotifications } from '@/components/notifications';
import { Icon } from '@/components/signal';
import { cn } from '@/lib/utils';

/*
 * On a phone the sidebar is a drawer, so the bar at the bottom holds the five
 * places you go most: home, tasks, a raised button that opens the palette to
 * start something, the inbox with its unread dot, and reviews. Everything else
 * stays a tap away inside those places and the drawer.
 */

function Item({ to, label, icon, on, children }: { to: string; label: string; icon: typeof House; on: boolean; children?: ReactNode }) {
	return (
		<Link
			to={to}
			aria-label={label}
			className={cn(
				'flex h-11 w-14 flex-col items-center justify-center gap-0.5 rounded-card text-micro outline-none focus-visible:shadow-(--focus)',
				on ? 'text-(--text)' : 'text-(--text-3)',
			)}
		>
			<span className="relative">
				<Icon icon={icon} size={20} />
				{children}
			</span>
			{label}
		</Link>
	);
}

export function MobileNav({ onNew }: { onNew: () => void }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const unread = loudUnread(useNotifications().data?.unread);
	return (
		<nav aria-label="Places" className="fixed inset-x-0 bottom-0 z-10 border-t border-(--line) bg-(--bg-panel) pb-[env(safe-area-inset-bottom)] md:hidden">
			<div className="mx-auto flex h-14 max-w-md items-stretch justify-around">
				<Item to="/" label="Home" icon={House} on={pathname === '/'} />
				<Item to="/tasks" label="Tasks" icon={ListTodo} on={pathname === '/tasks' || pathname.startsWith('/agents/')} />
				<button
					type="button"
					onClick={onNew}
					aria-label="New task"
					className="mx-1 my-2 flex size-11 items-center justify-center self-center rounded-card bg-(--accent) text-(--accent-fg) shadow-(--sh-1) outline-none focus-visible:shadow-(--focus)"
				>
					<Icon icon={Plus} size={20} />
				</button>
				<Item to="/inbox" label="Inbox" icon={Inbox} on={pathname === '/inbox' || pathname.startsWith('/inbox/')}>
					{unread ? <span aria-hidden className="absolute -top-0.5 -right-1 size-2 rounded-full bg-(--accent)" /> : null}
				</Item>
				<Item to="/reviews" label="Reviews" icon={GitPullRequest} on={pathname === '/reviews' || pathname.startsWith('/reviews/')} />
			</div>
		</nav>
	);
}
