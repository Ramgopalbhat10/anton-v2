import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
	Activity,
	ArrowUpDown,
	CalendarDays,
	ChevronDown,
	ChevronRight,
	CircleDot,
	Cpu,
	Eye,
	FolderGit2,
	GitBranch,
	GitPullRequest,
	History,
	List,
	ListFilter,
	type LucideIcon,
	MoreHorizontal,
	PanelLeft,
	Pin,
	PinOff,
	Plus,
	RotateCcw,
	Rows2,
	Rows3,
	Search,
	Settings,
	SlidersHorizontal,
	Square,
	X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
	Avatar,
	Icon,
	IconBtn,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuSub,
	MenuSubContent,
	MenuSubTrigger,
	MenuTrigger,
	SectionLabel,
} from '@/components/signal';
import { SegmentMeter, usedTone } from '@/components/instrument';
import { Logo } from '@/components/illustrations';
import { TaskMenu, TitleInput, useFork, usePin } from '@/components/task-actions';
import { TaskCues } from '@/components/task-cues';
import { TaskPeek } from '@/components/task-peek';
import { isLive, TaskStatusIcon } from '@/components/task-status';
import { api, SAFETY_NET_MS, type Session } from '@/lib/api';
import { age, dollars } from '@/lib/format';
import {
	activeAt,
	DEFAULT_VIEW,
	FACET_KEYS,
	FACETS,
	type FacetKey,
	filterCount,
	groups,
	optionLabel,
	readView,
	repoName,
	saveView,
	SORTS,
	type SortKey,
	sections,
	type TaskView,
	taskNote,
	toggleFilter,
} from '@/lib/task-view';
import { cn } from '@/lib/utils';

const NAV_ROW =
	'group relative flex h-[30px] items-center gap-2 rounded-lg px-2 text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring) data-[status=active]:bg-(--alpha-white-6)';

/** Today's spend against the daily cap, so it is visible before it blocks anything: a figure over a small block meter. */
function SpentToday() {
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget(), refetchInterval: SAFETY_NET_MS });
	if (!budget.data) return null;
	const { today, limits } = budget.data;
	const used = limits.dailyUsd ? today / limits.dailyUsd : 0;
	return (
		<Link to="/settings/$section" params={{ section: 'usage' }} className="flex min-w-0 flex-col gap-1.5 rounded-lg px-1 py-0.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)" title="Spent today">
			<span className={cn('in-num flex items-baseline justify-between gap-2 text-[11px]', budget.data.blocked ? 'text-(--danger-text)' : 'text-(--text-tertiary)')}>
				<span className="in-caption">Today</span>
				<span>
					<span className={budget.data.blocked ? undefined : 'text-(--text-primary)'}>{dollars(today)}</span>
					{limits.dailyUsd !== null ? ` / $${limits.dailyUsd}` : ''}
				</span>
			</span>
			{limits.dailyUsd !== null ? <SegmentMeter label="Today's spend against the daily cap" value={used} segments={20} tone={usedTone(used)} height={5} /> : null}
		</Link>
	);
}

/** Anton's mark: a lit cube, drawn in the same isometric projection as the illustrations. */
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

const FACET_ICON: Record<FacetKey, LucideIcon> = { status: CircleDot, pr: GitPullRequest, repo: FolderGit2, model: Cpu, created: CalendarDays };

/**
 * Sort, filter, group and what each row shows, in one menu with a submenu each.
 * Picking a filter or a detail keeps the menu open, so several can be picked.
 */
function ViewMenu({ view, onChange, tasks }: { view: TaskView; onChange: (next: TaskView) => void; tasks: Session[] }) {
	const navigate = useNavigate();
	const active = filterCount(view.filters);
	const stay = (change: () => void) => (event: Event) => {
		event.preventDefault();
		change();
	};
	const details = [
		['repo', 'Repository'],
		['time', 'Last active'],
		['spend', 'Spend'],
	] as const;
	return (
		<Menu>
			<MenuTrigger asChild>
				<IconBtn icon={SlidersHorizontal} size="xs" label="View options" className={cn(active > 0 && 'text-(--accent-text)')} />
			</MenuTrigger>
			<MenuContent side="right" align="start" sideOffset={6} className="w-[224px]">
				<MenuSub>
					<MenuSubTrigger icon={ArrowUpDown} hint={SORTS[view.sort].label}>
						Sort
					</MenuSubTrigger>
					<MenuSubContent>
						{Object.entries(SORTS).map(([key, { label }]) => (
							<MenuItem key={key} checked={view.sort === key} onSelect={() => onChange({ ...view, sort: key as SortKey })}>
								{label}
							</MenuItem>
						))}
					</MenuSubContent>
				</MenuSub>
				<MenuSub>
					<MenuSubTrigger icon={ListFilter} hint={active || undefined}>
						Filter
					</MenuSubTrigger>
					<MenuSubContent>
						{FACET_KEYS.map((key) => {
							const options = FACETS[key].options(tasks);
							return (
								<MenuSub key={key}>
									<MenuSubTrigger icon={FACET_ICON[key]} hint={view.filters[key].length || undefined}>
										{FACETS[key].label}
									</MenuSubTrigger>
									<MenuSubContent>
										{options.length ? (
											options.map((option) => (
												<MenuItem
													key={option.value}
													checked={view.filters[key].includes(option.value)}
													hint={tasks.filter((task) => FACETS[key].test(task, option.value)).length}
													onSelect={stay(() => onChange(toggleFilter(view, key, option.value)))}
												>
													{option.label}
												</MenuItem>
											))
										) : (
											<MenuItem disabled>No tasks yet</MenuItem>
										)}
									</MenuSubContent>
								</MenuSub>
							);
						})}
						<MenuSeparator />
						<MenuItem icon={X} disabled={active === 0} onSelect={() => onChange({ ...view, filters: DEFAULT_VIEW.filters })}>
							Clear filters
						</MenuItem>
					</MenuSubContent>
				</MenuSub>
				<MenuSub>
					<MenuSubTrigger icon={Rows3} hint={view.group === 'repo' ? 'Repository' : 'None'}>
						Group
					</MenuSubTrigger>
					<MenuSubContent>
						<MenuItem checked={view.group === 'none'} onSelect={() => onChange({ ...view, group: 'none' })}>
							None
						</MenuItem>
						<MenuItem checked={view.group === 'repo'} onSelect={() => onChange({ ...view, group: 'repo' })}>
							Repository
						</MenuItem>
					</MenuSubContent>
				</MenuSub>
				<MenuSub>
					<MenuSubTrigger icon={Eye} hint={details.filter(([key]) => view.show[key]).length + 1}>
						Details
					</MenuSubTrigger>
					<MenuSubContent>
						<MenuItem checked disabled>
							Status and pull request
						</MenuItem>
						{details.map(([key, label]) => (
							<MenuItem key={key} checked={view.show[key]} onSelect={stay(() => onChange({ ...view, show: { ...view.show, [key]: !view.show[key] } }))}>
								{label}
							</MenuItem>
						))}
					</MenuSubContent>
				</MenuSub>
				<MenuItem
					icon={Rows2}
					role="menuitemcheckbox"
					aria-checked={view.compact}
					onSelect={stay(() => onChange({ ...view, compact: !view.compact }))}
					hint={
						<span aria-hidden className={cn('relative inline-flex h-3.5 w-6 rounded-full align-middle', view.compact ? 'bg-(--accent-base)' : 'bg-(--neutral-600)')}>
							<span className={cn('absolute top-0.5 size-2.5 rounded-full bg-white transition-transform', view.compact ? 'translate-x-3' : 'translate-x-0.5')} />
						</span>
					}
				>
					Compact view
				</MenuItem>
				<MenuSeparator />
				<MenuItem icon={List} onSelect={() => void navigate({ to: '/tasks' })}>
					Open the task list
				</MenuItem>
				<MenuItem icon={RotateCcw} onSelect={() => onChange(DEFAULT_VIEW)}>
					Reset view
				</MenuItem>
			</MenuContent>
		</Menu>
	);
}

/** The filters in use, each a chip that removes itself. */
function FilterChips({ view, onChange, tasks }: { view: TaskView; onChange: (next: TaskView) => void; tasks: Session[] }) {
	const chips = FACET_KEYS.flatMap((key) => view.filters[key].map((value) => ({ key, value, label: optionLabel(key, value, tasks) })));
	return (
		<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
			{chips.map(({ key, value, label }) => (
				<button
					key={`${key}:${value}`}
					type="button"
					aria-label={`Remove the ${label} filter`}
					onClick={() => onChange(toggleFilter(view, key, value))}
					className="flex h-5 max-w-full items-center gap-1 rounded-full bg-(--accent-bg-subtle) pr-1 pl-1.5 text-[11px] text-(--accent-text) outline-none hover:bg-(--accent-bg) focus-visible:shadow-(--focus-ring)"
				>
					<Icon icon={FACET_ICON[key]} size={10} />
					<span className="truncate">{label}</span>
					<Icon icon={X} size={10} />
				</button>
			))}
		</div>
	);
}

/** Search every task, and the view menu, above the sections they shape. */
function Toolbar({
	view,
	onChange,
	tasks,
	query,
	onQuery,
}: {
	view: TaskView;
	onChange: (next: TaskView) => void;
	tasks: Session[];
	query: string;
	onQuery: (next: string) => void;
}) {
	const [searching, setSearching] = useState(false);
	const close = () => {
		onQuery('');
		setSearching(false);
	};
	if (searching || query) {
		return (
			<div className="mx-2 mt-2 flex h-7 items-center gap-2 rounded-lg bg-(--bg-raised) px-2">
				<Icon icon={Search} size={12} className="text-(--icon-tertiary)" />
				<input
					autoFocus
					value={query}
					onChange={(event) => onQuery(event.target.value)}
					onKeyDown={(event) => event.key === 'Escape' && close()}
					placeholder="Search tasks"
					aria-label="Search tasks"
					className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-(--text-primary) outline-none"
				/>
				<button type="button" aria-label="Close search" onClick={close} className="inline-flex shrink-0 text-(--icon-tertiary) hover:text-(--text-primary)">
					<Icon icon={X} size={12} />
				</button>
			</div>
		);
	}
	const active = filterCount(view.filters);
	return (
		<div className="flex min-h-7 items-center gap-0.5 pt-2 pr-1.5 pl-4">
			{active ? (
				<FilterChips view={view} onChange={onChange} tasks={tasks} />
			) : (
				<span className="min-w-0 flex-1 truncate text-[11px] text-(--text-disabled)">
					{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
				</span>
			)}
			<IconBtn icon={Search} size="xs" label="Search tasks" onClick={() => setSearching(true)} />
			<ViewMenu view={view} onChange={onChange} tasks={tasks} />
		</div>
	);
}

const SECTION_ICON: Record<Place, LucideIcon> = { pinned: Pin, running: Activity, recent: History };

/** A section's heading: click it to fold the section away. Its actions show while the pointer is on it. */
function SectionHeader({
	place,
	label,
	count,
	open,
	onToggle,
	children,
}: {
	place: Place;
	label: string;
	count: number;
	open: boolean;
	onToggle: () => void;
	children?: ReactNode;
}) {
	return (
		<div className="group/header mt-2 flex h-7 items-center gap-0.5 pr-1.5 pl-2">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-(--text-tertiary) outline-none hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring)"
			>
				<Icon icon={SECTION_ICON[place]} size={12} className="text-(--icon-tertiary)" />
				<SectionLabel className="truncate">{label}</SectionLabel>
				{count ? <span className="text-[11px] text-(--text-disabled)">{count}</span> : null}
				<Icon icon={open ? ChevronDown : ChevronRight} size={12} className="text-(--icon-tertiary)" />
			</button>
			{children ? (
				// Stays while its menu is open, which Radix marks on the trigger.
				<div className="flex shrink-0 items-center opacity-0 group-focus-within/header:opacity-100 group-hover/header:opacity-100 has-data-[state=open]:opacity-100">
					{children}
				</div>
			) : null}
		</div>
	);
}

/** Stops every sandbox, asking twice inside the menu as it stops them all at once. */
function RunningMenu({ running }: { running: number }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const stopAll = useMutation({ mutationFn: api.stopAllSandboxes, onSettled: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }) });
	return (
		<Menu onOpenChange={(open) => !open && setConfirming(false)}>
			<MenuTrigger asChild>
				<IconBtn icon={MoreHorizontal} size="xs" label="Running options" />
			</MenuTrigger>
			<MenuContent side="right" align="start" sideOffset={6}>
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
			</MenuContent>
		</Menu>
	);
}

type Place = 'pinned' | 'running' | 'recent';

/** On hover: pinned tasks offer Unpin, running ones fork and stop, the rest Pin. All have the task menu. */
function HoverActions({ session, place }: { session: Session; place: Place }) {
	const queryClient = useQueryClient();
	const stop = useMutation({
		mutationFn: () => api.stopSession(session.id),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
	});
	const fork = useFork(session);
	const pin = usePin(session);
	if (place === 'running') {
		return (
			<>
				<IconBtn icon={GitBranch} size="xs" label="Fork into a new task" onClick={() => fork.mutate()} disabled={fork.isPending} />
				<IconBtn icon={Square} size="xs" label="Stop sandbox" onClick={() => stop.mutate()} disabled={stop.isPending} />
			</>
		);
	}
	const pinned = place === 'pinned';
	return <IconBtn icon={pinned ? PinOff : Pin} size="xs" label={pinned ? 'Unpin' : 'Pin to top'} onClick={() => pin.mutate()} disabled={pin.isPending} />;
}

/** The line under a row's title: links to act on (pull request, CI, a plan to review), then the details the view asks for. */
function Subtitle({ session, show, onCardChange }: { session: Session; show: TaskView['show']; onCardChange: (open: boolean) => void }) {
	const details = [show.repo && repoName(session.repo), show.time && age(activeAt(session)), show.spend && session.usage.cost > 0 && dollars(session.usage.cost)].filter(
		(part): part is string => Boolean(part),
	);
	return (
		<div className="flex min-w-0 items-center gap-2 text-[11px] tracking-[0.01em] text-(--text-tertiary)">
			<span className="pointer-events-auto contents">
				<TaskCues session={session} onCardChange={onCardChange} />
			</span>
			{details.length ? <span className="truncate">{details.join(' · ')}</span> : null}
		</div>
	);
}

/**
 * One task in the sidebar. The whole row links to the task, under the links its line holds;
 * its actions show on hover and stay while its menu is open, and resting on it shows a card of details.
 */
function TaskRow({ session, place, view, active, onNavigate }: { session: Session; place: Place; view: TaskView; active: boolean; onNavigate: () => void }) {
	const [renaming, setRenaming] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [cardOpen, setCardOpen] = useState(false);
	const note = taskNote(session);
	const live = isLive(session);
	return (
		<TaskPeek session={session} disabled={menuOpen || renaming || cardOpen}>
			<div data-open={menuOpen || undefined} className={cn('group relative flex items-center rounded-lg hover:bg-(--bg-hover)', view.compact ? 'h-[30px]' : 'h-11')}>
				{active ? <div className="absolute inset-0 rounded-lg bg-(--alpha-white-6)" /> : null}
				{renaming ? (
					<div className="relative flex min-w-0 flex-1 px-1">
						<TitleInput session={session} onDone={() => setRenaming(false)} className="min-w-0 flex-1" />
					</div>
				) : (
					<>
						<Link
							to="/agents/$sessionId"
							params={{ sessionId: session.id }}
							search={{ app: 'code' }}
							onClick={onNavigate}
							aria-label={session.title}
							className="absolute inset-0 rounded-lg outline-none focus-visible:shadow-(--focus-ring)"
						/>
						<div
							className={cn(
								'pointer-events-none relative flex h-full min-w-0 flex-1 items-center gap-2 pr-1.5 pl-2',
								active || live ? 'text-(--text-primary)' : 'text-(--text-secondary) group-hover:text-(--text-primary)',
							)}
						>
							<span className={cn('inline-flex shrink-0', !view.compact && 'self-start pt-[5px]', live && 'text-(--accent-text)')}>
								<TaskStatusIcon session={session} size={view.compact ? 12 : 13} />
							</span>
							<div className="flex min-w-0 flex-1 flex-col gap-px">
								<span className="truncate text-[13px]">{session.title}</span>
								{view.compact ? null : <Subtitle session={session} show={view.show} onCardChange={setCardOpen} />}
							</div>
							{/* Compact rows have no line for what waits on you, so a dot says it; it gives way to the row's actions on hover. */}
							{view.compact && note?.attention ? (
								<span
									role="img"
									aria-label={note.text}
									className={cn(
										'size-1.5 shrink-0 rounded-full group-focus-within:hidden group-hover:hidden group-data-open:hidden',
										note.tone === 'danger' ? 'bg-(--danger-base)' : 'bg-(--warning-base)',
									)}
								/>
							) : null}
						</div>
					</>
				)}
				{renaming ? null : (
					<div className="relative hidden shrink-0 items-center gap-px pr-1.5 group-focus-within:flex group-hover:flex group-data-open:flex">
						<HoverActions session={session} place={place} />
						<TaskMenu session={session} size="xs" side="right" onRename={() => setRenaming(true)} onOpenChange={setMenuOpen} />
					</div>
				)}
			</div>
		</TaskPeek>
	);
}

/** A section's rows, under a heading per repository when grouping. */
function Rows({ tasks, place, view, activeId, onNavigate }: { tasks: Session[]; place: Place; view: TaskView; activeId?: string; onNavigate: () => void }) {
	return (
		<div className="flex flex-col gap-0.5 px-2">
			{groups(tasks, view.group).map((group) => (
				<div key={group.key} className="flex flex-col gap-0.5">
					{group.label ? <div className="truncate px-2 pt-1.5 pb-0.5 text-[11px] text-(--text-disabled)">{group.label}</div> : null}
					{group.tasks.map((session) => (
						<TaskRow key={session.id} session={session} place={place} view={view} active={activeId === session.id} onNavigate={onNavigate} />
					))}
				</div>
			))}
		</div>
	);
}

function Empty({ children }: { children: ReactNode }) {
	return <div className="px-4 py-1.5 text-[12px] text-(--text-disabled)">{children}</div>;
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
	const [query, setQuery] = useState('');
	const [view, setView] = useState(readView);
	const changeView = (next: TaskView) => {
		setView(next);
		saveView(next);
	};
	const sessions = sessionsQuery.data?.sessions ?? [];
	const { pinned, running, recent } = sections(sessions, view, query);
	const narrowed = filterCount(view.filters) > 0 || query.trim() !== '';
	const folded = (place: Place) => view.collapsed.includes(place);
	const header = (place: Place, label: string, count: number) => ({
		place,
		label,
		count,
		open: !folded(place),
		onToggle: () => changeView({ ...view, collapsed: folded(place) ? view.collapsed.filter((item) => item !== place) : [...view.collapsed, place] }),
	});
	const rows = (tasks: Session[], place: Place) => <Rows tasks={tasks} place={place} view={view} activeId={params.sessionId} onNavigate={onNavigate} />;

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
				<Toolbar view={view} onChange={changeView} tasks={sessions} query={query} onQuery={setQuery} />
				{pinned.length ? (
					<section aria-label="Pinned">
						<SectionHeader {...header('pinned', 'Pinned', pinned.length)} />
						{folded('pinned') ? null : rows(pinned, 'pinned')}
					</section>
				) : null}
				<section aria-label="Running">
					<SectionHeader {...header('running', 'Running', running.length)}>
						<RunningMenu running={sessions.filter(isLive).length} />
					</SectionHeader>
					{folded('running') ? null : sessionsQuery.isError ? (
						<div className="px-4 py-1.5 text-[12px] text-(--danger-text)">Could not load tasks.</div>
					) : sessionsQuery.isPending ? (
						<div className="px-3">
							<div className="h-11 rounded-lg bg-(--bg-skeleton)" />
						</div>
					) : running.length ? (
						rows(running, 'running')
					) : (
						<Empty>{narrowed ? 'Nothing running matches.' : 'Nothing is running.'}</Empty>
					)}
				</section>
				<section aria-label="Recent">
					<SectionHeader {...header('recent', 'Recent', recent.length)} />
					{folded('recent') ? null : recent.length ? rows(recent, 'recent') : <Empty>{narrowed ? 'No stopped task matches.' : 'Stopped tasks show up here.'}</Empty>}
				</section>
				<div className="h-2 shrink-0" />
			</div>

			<div className="m-2 mt-0 flex shrink-0 flex-col gap-2 rounded-xl border border-(--border-subtle) bg-(--well-bg) p-2">
				<SpentToday />
				<div className="flex items-center gap-2">
					<Avatar name={name} />
					<div className="min-w-0 flex-1 truncate text-[12px] text-(--text-secondary)">{name}</div>
					<Link to="/settings" onClick={onNavigate} aria-label="Settings" title="Settings" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm">
						<Icon icon={Settings} size={14} />
					</Link>
				</div>
			</div>
		</aside>
	);
}
