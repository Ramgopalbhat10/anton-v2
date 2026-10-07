import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { GitBranch, GitPullRequest, List, ListFilter, MoreHorizontal, PanelLeft, Pin, PinOff, Plus, Search, Settings, Square, X } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, SectionLabel } from '@/components/signal';
import { TaskMenu, TitleInput, useFork, usePin } from '@/components/task-actions';
import { isLive, liveLabel, TaskStatusIcon } from '@/components/task-status';
import { api, SAFETY_NET_MS, type Session } from '@/lib/api';
import { age, dollars } from '@/lib/format';
import { cn } from '@/lib/utils';

const NAV_ROW =
	'group relative flex h-[30px] items-center gap-2 rounded-lg px-2 text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring) data-[status=active]:bg-(--alpha-white-6)';

/** Today's spend against the daily cap, so it is visible before it blocks anything. */
function SpentToday() {
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget(), refetchInterval: SAFETY_NET_MS });
	if (!budget.data) return null;
	const { today, limits } = budget.data;
	return (
		<span className={cn('shrink-0 text-[11px]', budget.data.blocked ? 'text-(--danger-text)' : 'text-(--text-tertiary)')} title="Spent today">
			{dollars(today)}
			{limits.dailyUsd !== null ? ` / $${limits.dailyUsd}` : ''}
		</span>
	);
}

export function Logo({ size = 20 }: { size?: number }) {
	return (
		<div
			className="flex shrink-0 items-center justify-center rounded-md bg-(--accent-base) text-[11px] font-semibold text-(--accent-fg)"
			style={{ width: size, height: size }}
		>
			A
		</div>
	);
}

/** Collapsed sidebar: a 48px rail with the mark, show-sidebar and new-task. */
export function SidebarRail({ onExpand }: { onExpand: () => void }) {
	const navigate = useNavigate();
	return (
		<nav className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-(--border-subtle) bg-(--bg-surface) py-2 md:flex">
			<div className="mb-2">
				<Logo />
			</div>
			<IconBtn icon={PanelLeft} size="sm" label="Show sidebar" onClick={onExpand} />
			<IconBtn icon={Plus} size="sm" label="New task" onClick={() => void navigate({ to: '/' })} />
		</nav>
	);
}

const RUNNING_FILTERS = {
	all: { label: 'All', test: (_session: Session) => true },
	working: { label: 'Working', test: (session: Session) => session.working || session.status === 'starting' },
	idle: { label: 'Idle', test: (session: Session) => !session.working && session.status === 'running' },
} satisfies Record<string, { label: string; test: (session: Session) => boolean }>;
type RunningFilter = keyof typeof RUNNING_FILTERS;

const RECENT_SORTS = {
	newest: { label: 'Newest first', compare: (a: Session, b: Session) => b.createdAt.localeCompare(a.createdAt) },
	spend: { label: 'Highest spend first', compare: (a: Session, b: Session) => b.usage.cost - a.usage.cost },
} satisfies Record<string, { label: string; compare: (a: Session, b: Session) => number }>;
type RecentSort = keyof typeof RECENT_SORTS;

/** Pinned tasks first, each group keeping its order. */
const pinnedFirst = (tasks: Session[]) => [...tasks.filter((task) => task.pinnedAt), ...tasks.filter((task) => !task.pinnedAt)];

function readSort(): RecentSort {
	try {
		return localStorage.getItem('anton.recentSort') === 'spend' ? 'spend' : 'newest';
	} catch {
		return 'newest';
	}
}

function saveSort(sort: RecentSort) {
	try {
		localStorage.setItem('anton.recentSort', sort);
	} catch {
		// Storage is a convenience; the list still sorts without it.
	}
}

/** The Running header: narrow by what the task is doing, stop every sandbox, or open the task list. */
function RunningHeader({ filter, onFilter, running }: { filter: RunningFilter; onFilter: (next: RunningFilter) => void; running: number }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const stopAll = useMutation({ mutationFn: api.stopAllSandboxes, onSettled: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }) });
	return (
		<div className="flex items-center gap-0.5 pt-4 pr-1.5 pb-1.5 pl-4">
			<SectionLabel className="min-w-0 flex-1">Running</SectionLabel>
			{filter !== 'all' ? (
				<button
					type="button"
					aria-label={`Clear the ${RUNNING_FILTERS[filter].label} filter`}
					onClick={() => onFilter('all')}
					className="flex h-[18px] items-center gap-1 rounded-full bg-(--bg-raised) px-1.5 text-[11px] text-(--text-secondary) hover:text-(--text-primary)"
				>
					{RUNNING_FILTERS[filter].label}
					<Icon icon={X} size={10} />
				</button>
			) : null}
			<Menu>
				<MenuTrigger asChild>
					<IconBtn icon={ListFilter} size="xs" label="Filter running tasks" />
				</MenuTrigger>
				<MenuContent align="end">
					{Object.entries(RUNNING_FILTERS).map(([key, { label }]) => (
						<MenuItem key={key} checked={filter === key} onSelect={() => onFilter(key as RunningFilter)}>
							{label}
						</MenuItem>
					))}
				</MenuContent>
			</Menu>
			<Menu onOpenChange={(open) => !open && setConfirming(false)}>
				<MenuTrigger asChild>
					<IconBtn icon={MoreHorizontal} size="xs" label="Running options" />
				</MenuTrigger>
				<MenuContent align="end">
					{/* Asks twice inside the menu, as it stops every task's sandbox at once. */}
					<MenuItem
						icon={Square}
						disabled={running === 0 || stopAll.isPending}
						onSelect={(event) => {
							if (confirming) return stopAll.mutate();
							event.preventDefault();
							setConfirming(true);
						}}
					>
						{confirming ? `Click again to stop ${running === 1 ? 'it' : `all ${running}`}` : 'Stop every sandbox'}
					</MenuItem>
					<MenuItem icon={List} onSelect={() => void navigate({ to: '/tasks' })}>
						Open the task list
					</MenuItem>
				</MenuContent>
			</Menu>
		</div>
	);
}

/** The Recent header: search, sort by age or spend, or open the task list. */
function RecentHeader({ sort, onSort, onSearch }: { sort: RecentSort; onSort: (next: RecentSort) => void; onSearch: () => void }) {
	const navigate = useNavigate();
	return (
		<div className="flex items-center gap-0.5 pt-4 pr-1.5 pb-1.5 pl-4">
			<SectionLabel className="min-w-0 flex-1">Recent</SectionLabel>
			<IconBtn icon={Search} size="xs" label="Search recent tasks" onClick={onSearch} />
			<Menu>
				<MenuTrigger asChild>
					<IconBtn icon={MoreHorizontal} size="xs" label="Recent options" />
				</MenuTrigger>
				<MenuContent align="end">
					{Object.entries(RECENT_SORTS).map(([key, { label }]) => (
						<MenuItem key={key} checked={sort === key} onSelect={() => onSort(key as RecentSort)}>
							{label}
						</MenuItem>
					))}
					<MenuSeparator />
					<MenuItem icon={List} onSelect={() => void navigate({ to: '/tasks' })}>
						Open the task list
					</MenuItem>
				</MenuContent>
			</Menu>
		</div>
	);
}

/** Running tasks offer fork and stop on hover; stopped ones offer pin. Both have the task menu. */
function HoverActions({ session, live }: { session: Session; live: boolean }) {
	const queryClient = useQueryClient();
	const stop = useMutation({
		mutationFn: () => api.stopSession(session.id),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
	});
	const fork = useFork(session);
	const pin = usePin(session);
	if (!live) {
		return <IconBtn icon={session.pinnedAt ? PinOff : Pin} size="xs" label={session.pinnedAt ? 'Unpin' : 'Pin to top'} onClick={() => pin.mutate()} disabled={pin.isPending} />;
	}
	return (
		<>
			<IconBtn icon={GitBranch} size="xs" label="Fork into a new task" onClick={() => fork.mutate()} disabled={fork.isPending} />
			<IconBtn icon={Square} size="xs" label="Stop sandbox" onClick={() => stop.mutate()} disabled={stop.isPending} />
		</>
	);
}

/** One task in the sidebar; its actions show on hover, and stay while its menu is open. */
function TaskRow({ session, live, active, onNavigate }: { session: Session; live: boolean; active: boolean; onNavigate: () => void }) {
	const [renaming, setRenaming] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	return (
		<div
			data-open={menuOpen || undefined}
			className={cn('group relative flex items-center rounded-lg hover:bg-(--bg-hover)', live ? 'h-11' : 'h-[30px]')}
		>
			{active ? <div className="absolute inset-0 rounded-lg bg-(--alpha-white-6)" /> : null}
			{renaming ? (
				<div className="relative flex min-w-0 flex-1 px-1">
					<TitleInput session={session} onDone={() => setRenaming(false)} className="min-w-0 flex-1" />
				</div>
			) : (
				<Link
					to="/agents/$sessionId"
					params={{ sessionId: session.id }}
					search={{ app: 'code' }}
					onClick={onNavigate}
					className={cn(
						'relative flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-1.5 pl-2 outline-none focus-visible:shadow-(--focus-ring)',
						!live && (active ? 'text-(--text-primary)' : 'text-(--text-secondary) hover:text-(--text-primary)'),
					)}
				>
					<span className={cn('inline-flex shrink-0', live && 'text-(--accent-text)')}>
						<TaskStatusIcon session={session} size={live ? 14 : 12} />
					</span>
					<div className="flex min-w-0 flex-1 flex-col gap-px">
						<div className={cn('flex min-w-0 items-center gap-1 text-[13px]', live && 'text-(--text-primary)')}>
							<span className="truncate">{session.title}</span>
							{session.pinnedAt ? <Icon icon={Pin} size={11} className="shrink-0 text-(--icon-tertiary)" /> : null}
						</div>
						{live ? (
							<div className="truncate text-[11px] tracking-[0.02em] text-(--text-tertiary)">
								{liveLabel(session)} · {age(session.createdAt)} · {session.repo.split('/').pop()}
							</div>
						) : null}
					</div>
					{live ? null : (
						<div className="shrink-0 text-[11px] text-(--text-disabled) group-focus-within:hidden group-hover:hidden group-data-open:hidden">
							{age(session.createdAt)}
						</div>
					)}
				</Link>
			)}
			{renaming ? null : (
				<div className="relative hidden shrink-0 items-center gap-px pr-1.5 group-focus-within:flex group-hover:flex group-data-open:flex">
					<HoverActions session={session} live={live} />
					<TaskMenu session={session} size="xs" onRename={() => setRenaming(true)} onOpenChange={setMenuOpen} />
				</div>
			)}
		</div>
	);
}

export function ChatSidebar({
	open,
	onNavigate,
	onCollapse,
	onOpenPalette,
}: {
	open: boolean;
	onNavigate: () => void;
	onCollapse: () => void;
	onOpenPalette: () => void;
}) {
	const params = useParams({ strict: false }) as { sessionId?: string };
	const profile = useQuery({ queryKey: ['profile'], queryFn: api.profile, staleTime: Number.POSITIVE_INFINITY });
	const name = profile.data?.name ?? 'You';
	const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: SAFETY_NET_MS });
	const [searching, setSearching] = useState(false);
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<RunningFilter>('all');
	const [sort, setSort] = useState(readSort);
	const sessions = sessionsQuery.data?.sessions ?? [];
	const live = sessions.filter(isLive);
	const running = pinnedFirst(live.filter(RUNNING_FILTERS[filter].test));
	const recent = pinnedFirst(
		sessions
			.filter((session) => !isLive(session))
			.filter((session) => session.title.toLowerCase().includes(query.trim().toLowerCase()))
			.sort(RECENT_SORTS[sort].compare),
	);
	const row = (session: Session) => (
		<TaskRow key={session.id} session={session} live={isLive(session)} active={params.sessionId === session.id} onNavigate={onNavigate} />
	);

	return (
		<aside
			className={cn(
				'w-64 min-w-0 shrink-0 flex-col border-r border-(--border-subtle) bg-(--bg-surface)',
				open ? 'fixed inset-y-0 left-0 z-30 flex shadow-(--shadow-modal) md:static md:shadow-none' : 'hidden md:flex',
			)}
		>
			<div className="flex h-11 shrink-0 items-center gap-1.5 pr-2 pl-3">
				<Logo />
				<div className="min-w-0 truncate text-[13px] font-medium">Anton</div>
				<div className="min-w-1 flex-[1_1_4px]" />
				<IconBtn icon={Search} size="xs" label="Command palette" onClick={onOpenPalette} />
				<IconBtn icon={PanelLeft} size="xs" label="Hide sidebar" onClick={onCollapse} className="hidden md:inline-flex" />
				<IconBtn icon={X} size="xs" label="Close sidebar" onClick={onNavigate} className="md:hidden" />
			</div>

			<div className="px-2 pb-2">
				<Link
					to="/"
					onClick={onNavigate}
					className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-(--bg-overlay) text-[13px] font-medium text-(--text-primary) transition-colors duration-(--duration-micro) outline-none hover:bg-(--neutral-700) focus-visible:shadow-(--focus-ring)"
				>
					<Icon icon={Plus} />
					<span>New task</span>
				</Link>
			</div>

			<div className="flex flex-col gap-0.5 px-2 py-1">
				<Link to="/tasks" onClick={onNavigate} className={NAV_ROW}>
					<Icon icon={List} className="text-(--icon-tertiary)" />
					<div className="min-w-0 flex-1 truncate text-[13px]">Tasks</div>
					<div className="text-[11px] text-(--text-tertiary)">{sessions.length}</div>
				</Link>
				<Link to="/reviews" onClick={onNavigate} className={NAV_ROW}>
					<Icon icon={GitPullRequest} className="text-(--icon-tertiary)" />
					<div className="min-w-0 flex-1 truncate text-[13px]">Reviews</div>
				</Link>
			</div>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<RunningHeader filter={filter} onFilter={setFilter} running={live.length} />
				<div className="flex flex-col gap-0.5 px-2">
					{sessionsQuery.isError ? (
						<div className="px-2 py-1.5 text-[12px] text-(--danger-text)">Could not load tasks.</div>
					) : sessionsQuery.isPending ? (
						<div className="flex flex-col gap-1 px-1">
							<div className="h-11 rounded-lg bg-(--bg-skeleton)" />
						</div>
					) : running.length === 0 ? (
						<div className="px-2 py-1.5 text-[12px] text-(--text-disabled)">{live.length === 0 ? 'Nothing is running.' : 'Nothing running matches this filter.'}</div>
					) : (
						running.map(row)
					)}
				</div>

				{searching ? (
					<div className="mx-2 mt-3.5 mb-1.5 ml-3 flex h-7 items-center gap-2 rounded-lg bg-(--bg-raised) px-2">
						<Icon icon={Search} size={12} className="text-(--icon-tertiary)" />
						<input
							autoFocus
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Escape') {
									setQuery('');
									setSearching(false);
								}
							}}
							placeholder="Search recent tasks"
							className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-(--text-primary) outline-none"
						/>
						<button
							type="button"
							aria-label="Close search"
							onClick={() => {
								setQuery('');
								setSearching(false);
							}}
							className="inline-flex shrink-0 text-(--icon-tertiary) hover:text-(--text-primary)"
						>
							<Icon icon={X} size={12} />
						</button>
					</div>
				) : (
					<RecentHeader
						sort={sort}
						onSort={(next) => {
							setSort(next);
							saveSort(next);
						}}
						onSearch={() => setSearching(true)}
					/>
				)}
				<div className="flex flex-col gap-0.5 px-2 pb-2">
					{recent.length === 0 ? (
						<div className="px-2 py-1.5 text-[12px] text-(--text-disabled)">
							{query ? 'No recent task matches that search.' : 'Stopped tasks show up here.'}
						</div>
					) : (
						recent.map(row)
					)}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-2 p-2">
				<Avatar name={name} />
				<div className="min-w-0 flex-1 truncate text-[12px] text-(--text-secondary)">{name}</div>
				<SpentToday />
				<Link to="/settings" onClick={onNavigate} aria-label="Settings" title="Settings" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm">
					<Icon icon={Settings} size={14} />
				</Link>
			</div>
		</aside>
	);
}
