import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
	ArrowUpRight,
	BellOff,
	Check,
	CheckCheck,
	ChevronDown,
	CircleCheck,
	CircleDot,
	FolderGit2,
	GitMerge,
	GitPullRequest,
	Hand,
	type LucideIcon,
	ListChecks,
	MessageCircleQuestion,
	MessageSquareText,
	OctagonAlert,
	Search,
	Server,
	ServerCrash,
	ServerOff,
	Wallet,
	X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, useNotifications } from '@/components/notifications';
import { Markdown } from '@/components/markdown';
import { StatusDot } from '@/components/instrument';
import { MenuButton } from '@/components/nav';
import { Badge, Btn, EmptyState, FilterChip, Icon, IconBtn, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, Spinner } from '@/components/signal';
import { api, type AppNotification, type NotificationCategory, type NotificationKind, repoShort, SAFETY_NET_MS } from '@/lib/api';
import { age, plainPreview } from '@/lib/format';
import { useOnePane } from '@/lib/one-pane';
import { useSpaces } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/**
 * The bell's page: the moments in your tasks worth a look, one row each under
 * its day. A row picks the moment; on a wide screen it opens beside the list
 * with the way to its task, on a phone the row goes straight there.
 */

type Tone = 'attention' | 'warning' | 'danger' | 'success' | 'accent' | 'neutral';

const LOOK: Record<NotificationKind, { label: string; icon: LucideIcon; tone: Tone }> = {
	question: { label: 'Asked you', icon: MessageCircleQuestion, tone: 'attention' },
	plan: { label: 'Plan ready', icon: ListChecks, tone: 'attention' },
	approval: { label: 'Needs approval', icon: Hand, tone: 'attention' },
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

/** A kind's colour, on its label and its bare icon: no tile behind either, like every other icon in the app. */
const TONE: Record<Tone, { text: string; icon: string }> = {
	attention: { text: 'text-(--warn)', icon: 'text-(--warn)' },
	warning: { text: 'text-(--warn)', icon: 'text-(--warn)' },
	danger: { text: 'text-(--bad)', icon: 'text-(--bad)' },
	success: { text: 'text-(--ok)', icon: 'text-(--ok)' },
	accent: { text: 'text-(--accent-text)', icon: 'text-(--accent-text)' },
	neutral: { text: 'text-(--text-3)', icon: 'text-(--text-3)' },
};

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

/** What the way there is called: a thread or project opens as itself, anything else as the task it is about. */
function openLabel(url: string): string {
	if (url.includes('/threads/')) return 'Open thread';
	if (url.startsWith('/projects/')) return 'Open project';
	return 'Open task';
}

/** One attribute filter: a hairline chip that opens a menu of what it can be, tinted when it is set. */
function FilterMenu({
	icon,
	label,
	anyLabel,
	value,
	valueLabel,
	options,
	onPick,
}: {
	icon: LucideIcon;
	label: string;
	anyLabel: string;
	value: string | null;
	valueLabel: string | null;
	options: Array<{ id: string; label: string; hint?: number }>;
	onPick: (id: string | null) => void;
}) {
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					className={cn(
						'inline-flex h-6 max-w-[220px] shrink-0 items-center gap-1.5 rounded-control px-2 text-small whitespace-nowrap outline-none transition-colors duration-(--t-fast) focus-visible:shadow-(--focus)',
						value
							? 'bg-(--accent-soft) text-(--accent-text) shadow-[inset_0_0_0_1px_var(--accent-line)]'
							: 'text-(--text-2) shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-(--bg-hover) hover:text-(--text)',
					)}
				>
					<Icon icon={icon} size={12} className="shrink-0" />
					<span className="truncate">{value ? `${label}: ${valueLabel}` : label}</span>
					<Icon icon={ChevronDown} size={12} className="shrink-0 text-(--text-3)" />
				</button>
			</MenuTrigger>
			<MenuContent align="start">
				<MenuItem checked={value === null} onSelect={() => onPick(null)}>
					{anyLabel}
				</MenuItem>
				{options.map((option) => (
					<MenuItem key={option.id} checked={value === option.id} onSelect={() => onPick(option.id)} hint={option.hint}>
						{option.label}
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}

export function InboxPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data, isPending, isError } = useNotifications();
	const spaces = useSpaces();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: SAFETY_NET_MS });
	const onePane = useOnePane();
	const [filters, setFilters] = useState(readFilters);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [cursor, setCursor] = useState(-1);

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
	const filtered = filters.unreadOnly || filters.categories.length > 0 || filters.place !== 'all';

	// The picked row is the cursor's when the keyboard moved it, else the first the filters leave.
	const picked = shown.find((notification) => notification.id === selectedId) ?? shown[cursor >= 0 ? cursor : 0] ?? null;

	const where = (notification: AppNotification) => {
		if (notification.spaceId) return spaceName.get(notification.spaceId) ?? 'Project';
		const task = notification.sessionId ? taskOf.get(notification.sessionId) : undefined;
		return task ? repoShort(task) : 'Task';
	};

	const openRow = (notification: AppNotification) => {
		if (!notification.read) read.mutate({ ids: [notification.id] });
		void navigate({ to: notification.url });
	};

	const pick = (notification: AppNotification) => {
		setSelectedId(notification.id);
		setCursor(shown.findIndex((row) => row.id === notification.id));
		if (onePane) openRow(notification);
	};

	// J and K move through the rows as the filters leave them; Enter goes where the picked one leads.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target;
			if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
			if (event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown') {
				event.preventDefault();
				setCursor((at) => Math.min(shown.length - 1, at + 1));
			} else if (event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp') {
				event.preventDefault();
				setCursor((at) => Math.max(-1, at - 1));
			} else if (event.key === 'Enter' && picked) {
				event.preventDefault();
				openRow(picked);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	useEffect(() => {
		if (cursor < 0 || cursor >= shown.length) return;
		document.getElementById(`inbox-row-${shown[cursor].id}`)?.scrollIntoView({ block: 'nearest' });
	}, [cursor, shown]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-3 pl-2 md:pl-4">
				<MenuButton />
				<nav aria-label="Where you are" className="flex min-w-0 items-center gap-1.5 text-body">
					<span className="font-medium text-(--text)">Inbox</span>
				</nav>
				{unreadCount ? <Badge tone="accent">{unreadCount} new</Badge> : null}
				<span className="min-w-2 flex-1" />
				<Btn size="sm" variant="ghost" icon={CheckCheck} disabled={!unreadCount || read.isPending} onClick={() => read.mutate({ all: true })}>
					<span className="hidden sm:inline">Mark all read</span>
				</Btn>
			</header>

			{isError ? (
				<div className="flex min-h-0 flex-1 items-center justify-center p-6 text-small text-(--bad)">Could not load notifications.</div>
			) : isPending ? (
				<div className="flex min-h-0 flex-1 items-center justify-center">
					<Spinner size={13} />
				</div>
			) : all.length === 0 ? (
				<EmptyState icon={BellOff} title="You are all caught up" body="Questions, approvals, finished work, failures and sandboxes starting or stopping show up here." />
			) : shown.length === 0 ? (
				<EmptyState icon={Search} title="Nothing matches these filters" body="Try another kind or place, or clear the filters." />
			) : (
				<>
					<div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-(--line) px-4 [scrollbar-width:none]">
						<FilterChip
							label="Unread"
							count={unreadCount}
							on={filters.unreadOnly}
							onToggle={() => {
								change({ unreadOnly: !filters.unreadOnly });
								setCursor(-1);
							}}
						/>
						{CATEGORIES.map((category) => {
							const on = filters.categories.includes(category.id);
							const count = countFor(category.id);
							const unread = data?.unread[category.id] ?? 0;
							return (
								<FilterChip
									key={category.id}
									label={category.label}
									count={count}
									on={on}
									onToggle={() => {
										change({ categories: on ? filters.categories.filter((item) => item !== category.id) : [...filters.categories, category.id] });
										setCursor(-1);
									}}
									mark={category.id === 'needs-you' && unread ? <StatusDot tone="attention" /> : category.id === 'failures' && unread ? <StatusDot tone="danger" /> : undefined}
								/>
							);
						})}
						<span className="mx-1 h-4 w-px shrink-0 bg-(--line)" />
						<FilterMenu
							icon={FolderGit2}
							label="From"
							anyLabel="Everywhere"
							value={filters.place === 'all' ? null : filters.place}
							valueLabel={placeLabel}
							options={[
								{ id: 'tasks', label: 'Tasks outside projects' },
								...projectsWithRows.map((id) => ({ id: `space:${id}`, label: spaceName.get(id) ?? 'Project' })),
							]}
							onPick={(id) => {
								change({ place: (id ?? 'all') as Place });
								setCursor(-1);
							}}
						/>
						{filtered ? (
							<button
								type="button"
								onClick={() => {
									change(DEFAULT_FILTERS);
									setCursor(-1);
								}}
								className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-control px-2 text-small text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
							>
								<Icon icon={X} size={12} />
								Clear
							</button>
						) : null}
					</div>

					<div className="flex min-h-0 flex-1">
						<div className="flex w-[min(400px,100%)] shrink-0 flex-col border-r border-(--line)">
							<div className="min-h-0 flex-1 overflow-y-auto">
								{groups.map((group) => (
									<section key={group.label} aria-label={group.label}>
										<div className="px-3.5 pt-3 pb-1 text-micro font-medium tracking-wide text-(--text-4) uppercase">{group.label}</div>
										<ul className="flex flex-col gap-px px-1.5 pb-2">
											{group.rows.map((notification) => (
												<Row
													key={notification.id}
													notification={notification}
													where={where(notification)}
													on={picked?.id === notification.id}
													onPick={() => pick(notification)}
													onToggleRead={() => read.mutate({ ids: [notification.id], read: !notification.read })}
												/>
											))}
										</ul>
									</section>
								))}
							</div>
						</div>
						{onePane ? null : picked ? (
							<Detail notification={picked} where={where(picked)} onOpen={() => openRow(picked)} onToggleRead={() => read.mutate({ ids: [picked.id], read: !picked.read })} />
						) : (
							<div className="flex min-w-0 flex-1 items-center justify-center p-6 text-small text-(--text-4)">Pick a moment to see it here.</div>
						)}
					</div>

					<footer className="flex h-8 shrink-0 items-center gap-3 border-t border-(--line) px-4 text-small text-(--text-4)">
						<span className="in-num">
							{shown.length} of {all.length}
						</span>
						<span className="min-w-0 flex-1" />
						<span className="hidden items-center gap-1.5 sm:flex">
							<Kbd keys="j" size="sm" />
							<Kbd keys="k" size="sm" />
							move
						</span>
						<span className="hidden items-center gap-1.5 sm:flex">
							<Kbd keys="enter" size="sm" />
							open
						</span>
					</footer>
				</>
			)}
		</div>
	);
}

function Row({
	notification,
	where,
	on,
	onPick,
	onToggleRead,
}: {
	notification: AppNotification;
	where: string;
	on: boolean;
	onPick: () => void;
	onToggleRead: () => void;
}) {
	const look = LOOK[notification.kind];
	const tone = TONE[look.tone];
	return (
		<li id={`inbox-row-${notification.id}`} className="group/row relative">
			<button
				type="button"
				onClick={onPick}
				aria-current={on || undefined}
				className={cn(
					'flex w-full items-start gap-3 rounded-control px-2.5 py-2.5 pr-9 text-left outline-none transition-colors duration-(--t-fast) focus-visible:shadow-(--focus)',
					on ? 'bg-(--bg-active)' : 'hover:bg-(--bg-hover)',
					notification.read && 'opacity-[0.72] hover:opacity-100',
				)}
			>
				<span className={cn('mt-[3px] inline-flex size-4 shrink-0 items-center justify-center', tone.icon)}>
					<Icon icon={look.icon} size={15} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					{notification.read ? null : <span className="sr-only">Unread: </span>}
					<span className="flex min-w-0 items-center gap-2">
						<span className={cn('min-w-0 flex-1 truncate text-body', notification.read ? 'text-(--text-2)' : 'font-medium text-(--text)')}>{notification.title}</span>
					</span>
					<span className="truncate text-small leading-[17px] text-(--text-3)">{plainPreview(notification.body)}</span>
					<span className="flex min-w-0 items-center gap-1.5 pt-0.5 text-micro">
						<span className={cn('shrink-0 font-medium', tone.text)}>{look.label}</span>
						<span className="text-(--text-4)">·</span>
						<span className="min-w-0 truncate text-(--text-4)">{where}</span>
					</span>
				</span>
				<span className="mt-1 flex shrink-0 flex-col items-end gap-1.5">
					<span className="text-micro text-(--text-4) tabular-nums" title={new Date(notification.createdAt).toLocaleString()}>
						{age(notification.createdAt)}
					</span>
					{notification.read ? null : <span aria-hidden className="size-1.5 rounded-full bg-(--accent)" />}
				</span>
			</button>
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

/** The picked moment beside the list: what it says, where it is from, and the way to its task. */
function Detail({
	notification,
	where,
	onOpen,
	onToggleRead,
}: {
	notification: AppNotification;
	where: string;
	onOpen: () => void;
	onToggleRead: () => void;
}) {
	const look = LOOK[notification.kind];
	const tone = TONE[look.tone];
	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-[620px] flex-col gap-4 px-6 py-8">
					<div className="flex items-center gap-2 text-small">
						<Icon icon={look.icon} size={14} className={tone.icon} />
						<span className={cn('font-medium', tone.text)}>{look.label}</span>
						<span className="text-(--text-4)">·</span>
						<span className="min-w-0 truncate text-(--text-3)">{where}</span>
						<span className="min-w-0 flex-1" />
						<span className="shrink-0 text-(--text-4) tabular-nums" title={new Date(notification.createdAt).toLocaleString()}>
							{age(notification.createdAt)}
						</span>
					</div>
					<h2 className="m-0 text-h2 leading-[26px] font-semibold tracking-[-0.01em] text-(--text)">{notification.title}</h2>
					<Markdown text={notification.body} />
				</div>
			</div>
			<footer className="flex h-12 shrink-0 items-center gap-2 border-t border-(--line) px-4">
				<Btn size="sm" variant="ghost" onClick={onToggleRead}>
					{notification.read ? 'Mark unread' : 'Mark read'}
				</Btn>
				<span className="min-w-0 flex-1" />
				<Btn size="sm" variant="primary" icon={ArrowUpRight} onClick={onOpen}>
					{openLabel(notification.url)}
				</Btn>
			</footer>
		</div>
	);
}
