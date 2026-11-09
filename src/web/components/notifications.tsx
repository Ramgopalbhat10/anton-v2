import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
	Bell,
	BellOff,
	Check,
	CheckCheck,
	CircleCheck,
	CircleDot,
	FolderKanban,
	GitMerge,
	GitPullRequest,
	Hand,
	ListChecks,
	type LucideIcon,
	MessageCircleQuestion,
	MessageSquareText,
	OctagonAlert,
	Server,
	ServerCrash,
	ServerOff,
	Wallet,
	X,
} from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useMemo, useState } from 'react';
import { Btn, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, PickerChip } from '@/components/signal';
import { type AppNotification, api, type NotificationCategory, type NotificationKind, type NotificationsView, repoShort, SAFETY_NET_MS } from '@/lib/api';
import { age } from '@/lib/format';
import { useSpaces } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/**
 * The bell beside the sidebar toggle and the dialog it opens: the moments in
 * your tasks worth a look (src/services/notifications.ts), not every step.
 * The list updates from server events; opening a task reads its rows.
 */

type Tone = 'warning' | 'danger' | 'success' | 'accent' | 'neutral';

const LOOK: Record<NotificationKind, { label: string; icon: LucideIcon; tone: Tone }> = {
	question: { label: 'Asked you', icon: MessageCircleQuestion, tone: 'warning' },
	plan: { label: 'Plan ready', icon: ListChecks, tone: 'warning' },
	approval: { label: 'Needs approval', icon: Hand, tone: 'warning' },
	replied: { label: 'Replied', icon: MessageSquareText, tone: 'accent' },
	done: { label: 'Done', icon: CircleCheck, tone: 'success' },
	merged: { label: 'Merged', icon: GitMerge, tone: 'success' },
	failed: { label: 'Failed', icon: OctagonAlert, tone: 'danger' },
	'checks-failed': { label: 'Checks failed', icon: GitPullRequest, tone: 'danger' },
	budget: { label: 'Spending cap', icon: Wallet, tone: 'danger' },
	'sandbox-ready': { label: 'Sandbox created', icon: Server, tone: 'neutral' },
	'sandbox-stopped': { label: 'Sandbox stopped', icon: ServerOff, tone: 'neutral' },
	'sandbox-failed': { label: 'Sandbox failed', icon: ServerCrash, tone: 'danger' },
};

const TONE: Record<Tone, { text: string; well: string }> = {
	warning: { text: 'text-(--warning-text)', well: 'bg-(--warning-bg) text-(--warning-text) shadow-[inset_0_0_0_1px_var(--warning-border)]' },
	danger: { text: 'text-(--danger-text)', well: 'bg-(--danger-bg) text-(--danger-text) shadow-[inset_0_0_0_1px_var(--danger-border)]' },
	success: { text: 'text-(--success-text)', well: 'bg-(--success-bg) text-(--success-text) shadow-[inset_0_0_0_1px_var(--success-border)]' },
	accent: { text: 'text-(--accent-text)', well: 'bg-(--accent-bg-subtle) text-(--accent-text) shadow-[inset_0_0_0_1px_var(--accent-border)]' },
	neutral: { text: 'text-(--text-tertiary)', well: 'bg-(--alpha-white-4) text-(--icon-secondary) shadow-[inset_0_0_0_1px_var(--border-subtle)]' },
};

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

/** Where rows come from: everywhere, tasks outside any project, or one project. */
type Place = 'all' | 'tasks' | `space:${string}`;
type Filters = { unreadOnly: boolean; categories: NotificationCategory[]; place: Place };
const DEFAULT_FILTERS: Filters = { unreadOnly: false, categories: [], place: 'all' };
const FILTERS_KEY = 'anton.notifications';

function readFilters(): Filters {
	try {
		const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? 'null') as Partial<Filters> | null;
		if (!saved) return DEFAULT_FILTERS;
		const known = new Set(CATEGORIES.map((category) => category.id));
		return {
			unreadOnly: saved.unreadOnly === true,
			categories: Array.isArray(saved.categories) ? saved.categories.filter((category) => known.has(category)) : [],
			place: typeof saved.place === 'string' && (saved.place === 'all' || saved.place === 'tasks' || saved.place.startsWith('space:')) ? saved.place : 'all',
		};
	} catch {
		return DEFAULT_FILTERS;
	}
}

function saveFilters(filters: Filters): void {
	try {
		localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
	} catch {
		// Storage is a convenience; the filters still work for this visit.
	}
}

export function useNotifications() {
	return useQuery({ queryKey: ['notifications'], queryFn: api.notifications, refetchInterval: SAFETY_NET_MS });
}

/** Unread rows that call you over: everything but sandboxes starting and stopping. */
export const loudUnread = (unread: NotificationsView['unread'] | undefined) =>
	unread ? CATEGORIES.filter((category) => !QUIET.includes(category.id)).reduce((sum, category) => sum + unread[category.id], 0) : 0;

/** The bell: a count of unread rows, amber while something waits on you and red when something failed. */
export function NotificationsBell({ onOpen, size = 'xs', className }: { onOpen: () => void; size?: 'xs' | 'sm'; className?: string }) {
	const { data } = useNotifications();
	const count = loudUnread(data?.unread);
	const tone = data?.unread.failures ? 'bg-(--danger-base)' : data?.unread['needs-you'] ? 'bg-(--warning-base)' : 'bg-(--accent-base)';
	return (
		<span className={cn('relative inline-flex shrink-0', className)}>
			<IconBtn icon={Bell} size={size} label={count ? `Notifications, ${count} unread` : 'Notifications'} onClick={onOpen} aria-haspopup="dialog" />
			{count ? (
				<span
					aria-hidden
					className={cn(
						'pointer-events-none absolute -top-1 -right-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-[3px] text-[9.5px] leading-none font-semibold text-(--neutral-950) tabular-nums shadow-[0_0_0_2px_var(--bg-surface)]',
						tone,
					)}
				>
					{count > 99 ? '99+' : count}
				</span>
			) : null}
		</span>
	);
}

const DAY_MS = 24 * 60 * 60_000;

/** Today, Yesterday, This week and Older, from local midnight. */
function dayGroup(iso: string, now = new Date()): string {
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const at = new Date(iso).getTime();
	if (at >= midnight) return 'Today';
	if (at >= midnight - DAY_MS) return 'Yesterday';
	if (at >= midnight - 6 * DAY_MS) return 'This week';
	return 'Older';
}

export function NotificationsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data, isPending, isError } = useNotifications();
	const spaces = useSpaces();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, enabled: open });
	const [filters, setFilters] = useState(readFilters);
	const change = (next: Partial<Filters>) =>
		setFilters((current) => {
			const updated = { ...current, ...next };
			saveFilters(updated);
			return updated;
		});

	const read = useMutation({
		mutationFn: (which: Parameters<typeof api.readNotifications>[0]) => api.readNotifications(which),
		onSuccess: (view) => queryClient.setQueryData(['notifications'], view),
	});

	const spaceName = useMemo(() => new Map((spaces.data?.spaces ?? []).map((space) => [space.id, space.name])), [spaces.data]);
	const taskOf = useMemo(() => new Map((sessions.data?.sessions ?? []).map((session) => [session.id, session])), [sessions.data]);
	const all = data?.notifications ?? [];
	const unreadCount = all.filter((notification) => !notification.read).length;

	const inPlace = (notification: AppNotification) =>
		filters.place === 'all' || (filters.place === 'tasks' ? !notification.spaceId : `space:${notification.spaceId}` === filters.place);
	const placed = all.filter(inPlace);
	const shown = placed.filter(
		(notification) => (!filters.unreadOnly || !notification.read) && (filters.categories.length === 0 || filters.categories.includes(notification.category)),
	);
	// Each chip counts what it would show among the rows the other filters leave.
	const countFor = (category: NotificationCategory) =>
		placed.filter((notification) => notification.category === category && (!filters.unreadOnly || !notification.read)).length;

	const groups: Array<{ label: string; rows: AppNotification[] }> = [];
	for (const notification of shown) {
		const label = dayGroup(notification.createdAt);
		const last = groups[groups.length - 1];
		if (last?.label === label) last.rows.push(notification);
		else groups.push({ label, rows: [notification] });
	}

	const placeLabel =
		filters.place === 'all' ? 'Everywhere' : filters.place === 'tasks' ? 'Tasks' : (spaceName.get(filters.place.slice('space:'.length)) ?? 'Project');
	const projectsWithRows = [...new Set(all.map((notification) => notification.spaceId).filter((id): id is string => Boolean(id)))];

	const openRow = (notification: AppNotification) => {
		if (!notification.read) read.mutate({ ids: [notification.id] });
		onClose();
		void navigate({ to: notification.url });
	};

	const where = (notification: AppNotification) => {
		if (notification.spaceId) return spaceName.get(notification.spaceId) ?? 'Project';
		const task = notification.sessionId ? taskOf.get(notification.sessionId) : undefined;
		return task ? repoShort(task) : 'Task';
	};

	const filtered = filters.unreadOnly || filters.categories.length > 0 || filters.place !== 'all';

	return (
		<Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-40 bg-(--bg-scrim) backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
				<Dialog.Content
					aria-describedby={undefined}
					className="in-pop in-pop--modal fixed top-[8vh] left-1/2 z-50 flex max-h-[min(84vh,760px)] w-[calc(100%-2rem)] max-w-[600px] -translate-x-1/2 flex-col overflow-hidden outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
				>
					<header className="flex h-12 shrink-0 items-center gap-2 pr-2.5 pl-4 shadow-[inset_0_-1px_0_var(--border-subtle)]">
						<Icon icon={Bell} size={14} className="text-(--icon-secondary)" />
						<Dialog.Title className="text-[13.5px] font-medium">Notifications</Dialog.Title>
						{unreadCount ? <span className="text-[12px] text-(--text-tertiary) tabular-nums">{unreadCount} unread</span> : null}
						<div className="flex-1" />
						<Btn size="sm" variant="ghost" icon={CheckCheck} disabled={!unreadCount || read.isPending} onClick={() => read.mutate({ all: true })}>
							<span className="hidden sm:inline">Mark all read</span>
						</Btn>
						<Dialog.Close asChild>
							<IconBtn icon={X} size="sm" label="Close" />
						</Dialog.Close>
					</header>

					<div className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-2.5 shadow-[inset_0_-1px_0_var(--border-subtle)]">
						<div className="flex items-center gap-2">
							<div role="radiogroup" aria-label="Show" className="flex h-7 items-center gap-0.5 rounded-lg bg-(--well-bg) p-0.5 shadow-[inset_0_0_0_1px_var(--border-subtle)]">
								{([false, true] as const).map((unreadOnly) => (
									<button
										key={String(unreadOnly)}
										type="button"
										role="radio"
										aria-checked={filters.unreadOnly === unreadOnly}
										onClick={() => change({ unreadOnly })}
										className={cn(
											'flex h-6 items-center gap-1.5 rounded-md px-2.5 text-[12px] outline-none focus-visible:shadow-(--focus-ring)',
											filters.unreadOnly === unreadOnly ? 'bg-(--bg-selected) text-(--text-primary) shadow-(--card-highlight)' : 'text-(--text-tertiary) hover:text-(--text-secondary)',
										)}
									>
										{unreadOnly ? 'Unread' : 'All'}
										{unreadOnly ? <span className="text-(--text-disabled) tabular-nums">{unreadCount}</span> : null}
									</button>
								))}
							</div>
							<div className="flex-1" />
							<Menu>
								<MenuTrigger asChild>
									<PickerChip icon={FolderKanban} label={placeLabel} aria-label={`From: ${placeLabel}`} />
								</MenuTrigger>
								<MenuContent align="end" className="max-h-[50vh] overflow-y-auto">
									<MenuItem checked={filters.place === 'all'} onSelect={() => change({ place: 'all' })}>
										Everywhere
									</MenuItem>
									<MenuItem checked={filters.place === 'tasks'} onSelect={() => change({ place: 'tasks' })}>
										Tasks outside projects
									</MenuItem>
									{projectsWithRows.length ? (
										<>
											<MenuSeparator />
											<MenuLabel>Projects</MenuLabel>
											{projectsWithRows.map((id) => (
												<MenuItem key={id} checked={filters.place === `space:${id}`} onSelect={() => change({ place: `space:${id}` })}>
													{spaceName.get(id) ?? 'Project'}
												</MenuItem>
											))}
										</>
									) : null}
								</MenuContent>
							</Menu>
						</div>
						<div role="group" aria-label="Kinds" className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
							{CATEGORIES.map((category) => {
								const on = filters.categories.includes(category.id);
								const count = countFor(category.id);
								const unread = data?.unread[category.id] ?? 0;
								return (
									<button
										key={category.id}
										type="button"
										aria-pressed={on}
										aria-label={`${category.label}, ${count}`}
										onClick={() => change({ categories: on ? filters.categories.filter((item) => item !== category.id) : [...filters.categories, category.id] })}
										className={cn(
											'flex h-[24px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] transition-colors duration-(--duration-micro) outline-none focus-visible:shadow-(--focus-ring)',
											on
												? 'bg-(--accent-bg-subtle) text-(--accent-text) shadow-[inset_0_0_0_1px_var(--accent-border)]'
												: 'bg-(--alpha-white-4) text-(--text-tertiary) hover:text-(--text-secondary)',
										)}
									>
										{category.id === 'needs-you' && unread ? <span aria-hidden className="size-1.5 rounded-full bg-(--warning-base)" /> : null}
										{category.id === 'failures' && unread ? <span aria-hidden className="size-1.5 rounded-full bg-(--danger-base)" /> : null}
										{category.label}
										<span className={cn('tabular-nums', on ? 'text-(--accent-text)' : 'text-(--text-disabled)')}>{count}</span>
									</button>
								);
							})}
							{filtered ? (
								<button
									type="button"
									onClick={() => change(DEFAULT_FILTERS)}
									className="ml-auto h-[24px] shrink-0 rounded-md px-1.5 text-[11.5px] text-(--text-tertiary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
								>
									Clear
								</button>
							) : null}
						</div>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto">
						{isError ? (
							<div className="px-4 py-6 text-[12px] text-(--danger-text)">Could not load notifications.</div>
						) : isPending ? (
							<div className="flex flex-col gap-1.5 p-3">
								{[0, 1, 2].map((key) => (
									<div key={key} className="h-14 rounded-lg bg-(--bg-skeleton)" />
								))}
							</div>
						) : shown.length === 0 ? (
							<div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
								<span className="inline-flex size-9 items-center justify-center text-(--icon-secondary)">
									<Icon icon={BellOff} size={22} />
								</span>
								<div className="flex flex-col gap-1">
									<div className="text-[13.5px] font-medium">{filtered ? 'Nothing matches these filters' : 'You are all caught up'}</div>
									<div className="max-w-[44ch] text-[12px] leading-[18px] text-(--text-tertiary)">
										{filtered
											? 'Try another kind or place, or clear the filters.'
											: 'Questions, approvals, finished work, failures and sandboxes starting or stopping show up here.'}
									</div>
								</div>
							</div>
						) : (
							groups.map((group) => (
								<section key={group.label} aria-label={group.label} className="px-2 pb-1.5">
									<div className="sticky-veil sticky top-0 z-[1] px-2 pt-2.5 pb-1 text-[11px] font-medium tracking-[0.06em] text-(--text-disabled) uppercase">{group.label}</div>
									<ul className="flex flex-col gap-px">
										{group.rows.map((notification) => (
											<Row
												key={notification.id}
												notification={notification}
												where={where(notification)}
												onOpen={() => openRow(notification)}
												onToggleRead={() => read.mutate({ ids: [notification.id], read: !notification.read })}
											/>
										))}
									</ul>
								</section>
							))
						)}
					</div>

					<footer className="flex h-9 shrink-0 items-center gap-2 px-4 text-[11.5px] text-(--text-disabled) shadow-[inset_0_1px_0_var(--border-subtle)]">
						<span className="min-w-0 flex-1 truncate">Only what needs a look. Opening a task marks its notifications read.</span>
						<Link to="/settings/$section" params={{ section: 'notifications' }} onClick={onClose} className="shrink-0 text-(--text-tertiary) hover:text-(--text-primary)">
							Phone alerts
						</Link>
					</footer>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function Row({ notification, where, onOpen, onToggleRead }: { notification: AppNotification; where: string; onOpen: () => void; onToggleRead: () => void }) {
	const look = LOOK[notification.kind];
	const tone = TONE[look.tone];
	return (
		<li className="group/row relative">
			<button
				type="button"
				onClick={onOpen}
				className={cn(
					'flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 pr-10 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)',
					notification.read && 'opacity-[0.72] hover:opacity-100',
				)}
			>
				<span className={cn('mt-px inline-flex size-7 shrink-0 items-center justify-center rounded-[6px]', tone.well)}>
					<Icon icon={look.icon} size={14} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex min-w-0 items-center gap-2">
						<span className={cn('min-w-0 flex-1 truncate text-[13px]', notification.read ? 'text-(--text-secondary)' : 'font-medium text-(--text-primary)')}>{notification.title}</span>
						<span className="shrink-0 text-[11px] text-(--text-disabled) tabular-nums" title={new Date(notification.createdAt).toLocaleString()}>
							{age(notification.createdAt)}
						</span>
					</span>
					<span className="line-clamp-2 text-[12px] leading-[17px] text-(--text-tertiary)">{notification.body}</span>
					<span className="flex min-w-0 items-center gap-1.5 pt-0.5 text-[11px]">
						<span className={cn('shrink-0 font-medium', tone.text)}>{look.label}</span>
						<span className="text-(--text-disabled)">·</span>
						<span className="min-w-0 truncate text-(--text-disabled)">{where}</span>
					</span>
				</span>
			</button>
			{notification.read ? null : <span aria-label="Unread" className="pointer-events-none absolute top-3.5 right-3.5 size-1.5 rounded-full bg-(--accent-base) group-hover/row:opacity-0" />}
			<IconBtn
				icon={notification.read ? CircleDot : Check}
				size="xs"
				label={notification.read ? 'Mark unread' : 'Mark read'}
				onClick={onToggleRead}
				className="absolute top-2 right-1.5 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
			/>
		</li>
	);
}

/** Opening a task reads its rows, and a row that arrives while you look at it is read at once. A component of its own, so the list changing never re-renders the task. */
export function ReadNotificationsOf({ sessionId }: { sessionId: string }): null {
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
}
