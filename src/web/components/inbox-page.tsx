import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
	ArrowUpRight,
	BellOff,
	Check,
	CheckCheck,
	ChevronRight,
	CircleCheck,
	CircleDot,
	CircleX,
	FolderGit2,
	GitMerge,
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
import { Badge, Btn, EmptyState, FilterChip, FilterMenu, Icon, IconBtn, Kbd, Spinner } from '@/components/signal';
import { Glyph, type GlyphKind } from '@/components/thread-glyph';
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

/** How each kind reads: its words, and its mark — a task-state glyph where the moment is a state, else an icon in the colour of what happened. */
const LOOK: Record<NotificationKind, { label: string; icon: LucideIcon; glyph?: GlyphKind; color?: string }> = {
	question: { label: 'Asked you', icon: MessageCircleQuestion, glyph: 'waiting' },
	plan: { label: 'Plan ready', icon: ListChecks, glyph: 'review' },
	approval: { label: 'Needs approval', icon: Hand, glyph: 'waiting' },
	replied: { label: 'Replied', icon: MessageSquareText, color: 'text-(--text-3)' },
	done: { label: 'Done', icon: CircleCheck, glyph: 'resolved' },
	merged: { label: 'Merged', icon: GitMerge, color: 'text-(--merged)' },
	failed: { label: 'Failed', icon: OctagonAlert, glyph: 'failed' },
	'checks-failed': { label: 'Checks failed', icon: CircleX, color: 'text-(--bad)' },
	budget: { label: 'Spending cap', icon: Wallet, color: 'text-(--bad)' },
	'sandbox-ready': { label: 'Sandbox created', icon: Server, color: 'text-(--text-3)' },
	'sandbox-stopped': { label: 'Sandbox stopped', icon: ServerOff, color: 'text-(--text-3)' },
	'sandbox-failed': { label: 'Sandbox failed', icon: ServerCrash, color: 'text-(--bad)' },
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

	const header = (
		<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-2 pl-2 md:pl-4">
			<MenuButton />
			<nav aria-label="Where you are" className="flex min-w-0 items-center gap-1.5 text-body">
				<span className="font-medium text-(--text)">Inbox</span>
			</nav>
			{unreadCount ? <Badge tone="accent">{unreadCount} new</Badge> : null}
			<span className="min-w-2 flex-1" />
			<IconBtn icon={CheckCheck} size="sm" label="Mark all read" disabled={!unreadCount || read.isPending} onClick={() => read.mutate({ all: true })} />
		</header>
	);

	// Nothing to list: one pane, saying why.
	if (isError || isPending || all.length === 0) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				{header}
				{isError ? (
					<div className="flex min-h-0 flex-1 items-center justify-center p-6 text-small text-(--bad)">Could not load notifications.</div>
				) : isPending ? (
					<div className="flex min-h-0 flex-1 items-center justify-center">
						<Spinner size={13} />
					</div>
				) : (
					<EmptyState icon={BellOff} title="You are all caught up" body="Questions, approvals, finished work, failures and sandboxes starting or stopping show up here." />
				)}
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex min-h-0 w-full min-w-0 shrink-0 flex-col md:w-[380px] md:shadow-[-1px_0_0_var(--line)_inset]">
				{header}
				<div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-(--line) px-3.5 [scrollbar-width:none]">
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
							className="inline-flex h-6 shrink-0 items-center gap-1 rounded-control px-2 text-small text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
						>
							<Icon icon={X} size={12} />
							Clear
						</button>
					) : null}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{shown.length === 0 ? (
						<EmptyState icon={Search} title="Nothing matches these filters" body="Try another kind or place, or clear the filters." />
					) : (
						groups.map((group) => (
							<section key={group.label} aria-label={group.label}>
								<div className="px-3.5 pt-2.5 pb-1 text-micro font-medium tracking-[0.02em] text-(--text-3)">{group.label}</div>
								<ul className="m-0 flex list-none flex-col p-0">
									{group.rows.map((notification) => (
										<Row
											key={notification.id}
											notification={notification}
											where={where(notification)}
											on={!onePane && picked?.id === notification.id}
											onPick={() => pick(notification)}
											onToggleRead={() => read.mutate({ ids: [notification.id], read: !notification.read })}
										/>
									))}
								</ul>
							</section>
						))
					)}
				</div>

				<footer className="flex h-8 shrink-0 items-center gap-3 border-t border-(--line) px-3.5 text-small text-(--text-3)">
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
			</div>
			{onePane ? null : picked ? (
				<Detail notification={picked} where={where(picked)} onOpen={() => openRow(picked)} onToggleRead={() => read.mutate({ ids: [picked.id], read: !picked.read })} />
			) : (
				<div className="flex min-w-0 flex-1 items-center justify-center p-6 text-small text-(--text-4)">Pick a moment to see it here.</div>
			)}
		</div>
	);
}

/** A kind's mark: the task-state glyph it stands for, or the pull request's icon in its colour. */
function KindMark({ kind, size = 14 }: { kind: NotificationKind; size?: number }) {
	const look = LOOK[kind];
	if (look.glyph) return <Glyph kind={look.glyph} size={size} />;
	return <Icon icon={look.icon} size={size} className={look.color} />;
}

/** One moment: its mark, the task it is about over what happened, its age and an unread dot. */
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
	const preview = plainPreview(notification.body);
	return (
		<li id={`inbox-row-${notification.id}`} className="group/row relative not-first:border-t not-first:border-(--line)">
			<button
				type="button"
				onClick={onPick}
				aria-current={on || undefined}
				className={cn(
					'flex min-h-[52px] w-full items-start gap-2.5 px-3.5 pt-[9px] pb-2 text-left outline-none transition-colors duration-(--t-fast) focus-visible:shadow-(--focus-inset)',
					on ? 'bg-(--bg-active)' : 'hover:bg-(--bg-hover)',
				)}
			>
				<span className="mt-0.5 inline-flex shrink-0">
					<KindMark kind={notification.kind} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-px">
					{notification.read ? null : <span className="sr-only">Unread: </span>}
					<span className={cn('truncate text-body leading-[18px]', notification.read ? 'text-(--text-2)' : 'font-medium text-(--text)')}>{notification.title}</span>
					<span className="flex min-w-0 items-center gap-1.5 text-small leading-4 text-(--text-3)">
						<span className="shrink-0">{look.label}</span>
						<span className="text-(--text-4)">·</span>
						<span className="max-w-[40%] shrink-0 truncate">{where}</span>
						{preview ? (
							<>
								<span className="text-(--text-4)">·</span>
								<span className="min-w-0 truncate">{preview}</span>
							</>
						) : null}
					</span>
				</span>
				<span className="flex shrink-0 flex-col items-end gap-1.5 group-hover/row:invisible group-has-focus-visible/row:invisible">
					<span className="in-num text-small leading-[18px] text-(--text-3)" title={new Date(notification.createdAt).toLocaleString()}>
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
				className="absolute top-2 right-2.5 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
			/>
		</li>
	);
}

/** The picked moment beside the list: where it is from, what it says, and the way to its task. */
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
	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-3 pl-4">
				<nav aria-label="The moment picked" className="flex min-w-0 items-center gap-1.5 text-body text-(--text-3)">
					<span className="max-w-[160px] shrink-0 truncate">{where}</span>
					<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--text-4)" />
					<span className="min-w-0 truncate font-medium text-(--text)">{notification.title}</span>
				</nav>
				<span className="min-w-2 flex-1" />
				<Btn size="sm" variant="ghost" icon={notification.read ? CircleDot : Check} onClick={onToggleRead} className="shrink-0">
					{notification.read ? 'Mark unread' : 'Mark read'}
				</Btn>
				<Btn size="sm" variant="secondary" onClick={onOpen} className="shrink-0">
					{openLabel(notification.url)}
					<Icon icon={ArrowUpRight} size={13} />
				</Btn>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-[640px] flex-col gap-4 px-7 py-10">
					<div className="flex items-center gap-2 text-small text-(--text-3)">
						<KindMark kind={notification.kind} />
						<span className="min-w-0 truncate">
							{look.label}
							<span className="text-(--text-4)"> · </span>
							<span className="in-num" title={new Date(notification.createdAt).toLocaleString()}>
								{age(notification.createdAt)} ago
							</span>
						</span>
					</div>
					<h2 className="m-0 text-h2 leading-[26px] font-semibold tracking-[-0.015em] text-(--text)">{notification.title}</h2>
					<Markdown text={notification.body} />
				</div>
			</div>
		</div>
	);
}
