import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
	ArrowUpDown,
	CalendarDays,
	ChevronRight,
	CircleDot,
	Cpu,
	Eye,
	FolderGit2,
	FolderKanban,
	Home,
	GitBranch,
	GitPullRequest,
	List,
	ListFilter,
	type LucideIcon,
	PanelLeft,
	Pin,
	PinOff,
	RotateCcw,
	Rows2,
	Rows3,
	Search,
	Settings,
	Shapes,
	Server,
	SlidersHorizontal,
	Square,
	SquarePen,
	Waypoints,
	X,
} from 'lucide-react';
import { memo, type ReactNode, useMemo, useState } from 'react';
import { Avatar, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger, SearchField } from '@/components/signal';
import { Count, toneFill, usedTone } from '@/components/instrument';
import { Logo } from '@/components/illustrations';
import { NotificationsBell } from '@/components/notifications';
import { GroupHeading, ProjectSidebarBody, ProjectsSection } from '@/components/project-sidebar';
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
import { useSpaceName } from '@/lib/spaces';
import { openSettings } from '@/lib/settings-modal';
import { isStarting } from '@/lib/starting';
import { cn } from '@/lib/utils';

/* A page in the sidebar: 28px, filled on the page you are on, as the open task is. */
const NAV_ROW =
	'group/nav relative flex h-7 shrink-0 items-center gap-2 rounded-control px-2 text-body font-medium text-(--text-2) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus) data-[status=active]:bg-(--bg-active) data-[status=active]:text-(--text)';

/** A nav row's icon, bright on the page you are on. */
function NavIcon({ icon }: { icon: LucideIcon }) {
	return <Icon icon={icon} size={15} className="shrink-0 text-(--text-3) group-hover/nav:text-(--text-2) group-data-[status=active]/nav:text-(--text)" />;
}

/** Today's spend against the daily cap, so it is visible before it blocks anything: a figure over a small block meter. */
function SpentToday() {
	const budget = useQuery({ queryKey: ['budget'], queryFn: () => api.budget(), refetchInterval: SAFETY_NET_MS });
	if (!budget.data) return null;
	const { today, limits } = budget.data;
	const used = limits.dailyUsd ? today / limits.dailyUsd : 0;
	return (
		<Link to="/settings/$section" params={{ section: 'usage' }} className="-mx-1.5 flex min-w-0 flex-col gap-2 rounded-control px-1.5 py-1 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)" title="Spent today">
			<span className={cn('flex items-baseline gap-1 text-small', budget.data.blocked ? 'text-(--bad)' : 'text-(--text-3)')}>
				<span className="flex-1">Today</span>
				<span className={cn('in-num', !budget.data.blocked && 'text-(--text-2)')}>{dollars(today)}</span>
				{limits.dailyUsd !== null ? <span className={cn('in-num', !budget.data.blocked && 'text-(--text-4)')}>/ ${limits.dailyUsd}</span> : null}
			</span>
			{limits.dailyUsd !== null ? (
				<span
					role="meter"
					aria-label="Today's spend against the daily cap"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(Math.min(1, used) * 100)}
					className="block h-1 overflow-hidden rounded-full bg-(--bg-active)"
				>
					<span className="block h-full rounded-full" style={{ width: `${Math.min(100, Math.max(used > 0 ? 2 : 0, used * 100))}%`, background: toneFill(usedTone(used)) }} />
				</span>
			) : null}
		</Link>
	);
}

/** Collapsed sidebar: a 48px rail with the mark, show-sidebar and new-task, fading in as the sidebar slides away. */
export function SidebarRail({ shown, onExpand, onOpenNotifications }: { shown: boolean; onExpand: () => void; onOpenNotifications: () => void }) {
	const navigate = useNavigate();
	return (
		<nav
			data-shown={shown}
			className="sg-nav-rail absolute inset-y-0 left-0 hidden w-12 flex-col items-center gap-1 bg-(--bg-app) py-3 md:flex"
		>
			<div className="mb-2 flex h-7 items-center">
				<Logo size={18} />
			</div>
			<IconBtn icon={PanelLeft} size="sm" label="Show sidebar" onClick={onExpand} />
			<IconBtn icon={SquarePen} size="sm" label="New task" onClick={() => void navigate({ to: '/' })} />
			<NotificationsBell size="sm" onOpen={onOpenNotifications} />
		</nav>
	);
}

const FACET_ICON: Record<FacetKey, LucideIcon> = { status: CircleDot, sandbox: Server, pr: GitPullRequest, repo: FolderGit2, model: Cpu, created: CalendarDays };

/**
 * Sort, filter, group and what each row shows, in one menu with a submenu each.
 * Picking a filter or a detail keeps the menu open, so several can be picked.
 */
function ViewMenu({ view, onChange, tasks }: { view: TaskView; onChange: (next: TaskView) => void; tasks: Session[] }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const active = filterCount(view.filters);
	const running = tasks.filter(isLive).length;
	// Stopping every sandbox at once asks twice, inside the menu.
	const [confirming, setConfirming] = useState(false);
	const stopAll = useMutation({ mutationFn: api.stopAllSandboxes, onSettled: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }) });
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
		<Menu onOpenChange={(open) => !open && setConfirming(false)}>
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
						<span aria-hidden className={cn('relative inline-flex h-3.5 w-6 rounded-full align-middle', view.compact ? 'bg-(--accent)' : 'bg-(--track)')}>
							<span className={cn('absolute top-0.5 size-2.5 rounded-full bg-white transition-transform', view.compact ? 'translate-x-3' : 'translate-x-0.5')} />
						</span>
					}
				>
					Compact view
				</MenuItem>
				<MenuSeparator />
				<MenuItem
					icon={Square}
					disabled={running === 0 || stopAll.isPending}
					hint={running || undefined}
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
					className="flex h-5 max-w-full items-center gap-1 rounded-inner bg-(--accent-soft) pr-1 pl-1.5 text-micro font-medium text-(--accent-text) outline-none focus-visible:shadow-(--focus)"
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
	const open = searching || Boolean(query);
	const active = filterCount(view.filters);
	// Search turns into Close in the same spot, so the buttons never move.
	const actions = (
		<>
			{open ? (
				<IconBtn icon={X} size="xs" label="Close search" onClick={close} />
			) : (
				<IconBtn icon={Search} size="xs" label="Search tasks" onClick={() => setSearching(true)} />
			)}
			<ViewMenu view={view} onChange={onChange} tasks={tasks} />
		</>
	);
	if (open) {
		// The search takes the heading's own row: same height, same place, the field where the name and rule were.
		return (
			<div className="mt-3 flex h-6 shrink-0 items-center gap-1 pl-0.5">
				<SearchField size="sm" autoFocus value={query} onChange={onQuery} onEscape={close} placeholder="Search tasks" className="flex-1" />
				<span className="-my-1 flex shrink-0 items-center">{actions}</span>
			</div>
		);
	}
	if (active) {
		return (
			<div className="mt-3 flex min-h-6 items-center gap-1 pl-2">
				<FilterChips view={view} onChange={onChange} tasks={tasks} />
				<span className="flex shrink-0 items-center">{actions}</span>
			</div>
		);
	}
	// The group's heading: Pinned, Running and Recent are its sections.
	return (
		<GroupHeading label="Tasks" count={tasks.length}>
			{actions}
		</GroupHeading>
	);
}

/** How each section of Tasks is marked beside its name: live work in the accent, the rest quiet. */
function SectionMark({ place, count }: { place: Place; count: number }) {
	if (place === 'pinned') return <Icon icon={Pin} size={11} className="shrink-0 text-(--text-3)" />;
	const live = place === 'running' && count > 0;
	return (
		<span aria-hidden className="relative inline-flex size-[11px] shrink-0 items-center justify-center">
			{live ? <span className="absolute inset-0 animate-ping rounded-full bg-(--accent) opacity-30" /> : null}
			<span className={cn('size-[5px] rounded-full', live ? 'bg-(--accent)' : 'bg-(--text-4)')} />
		</span>
	);
}

/** A section's heading inside Tasks: click it to fold the section away. Its actions show while the pointer is on it. */
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
		<div className="group/header mt-1 flex h-6 items-center gap-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="group/fold flex h-6 min-w-0 items-center gap-2 rounded-control px-2 text-(--text-4) outline-none hover:text-(--text-2) focus-visible:shadow-(--focus)"
							>
								<SectionMark place={place} count={count} />
								<span className="truncate text-micro font-medium">{label}</span>
				{/* The count, and in its place on hover or focus the chevron that says the section folds. */}
				<span className="relative inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center">
					{count ? (
						<span className="in-num text-micro text-(--text-4) transition-opacity duration-(--t-fast) group-hover/fold:opacity-0 group-focus-visible/fold:opacity-0">{count}</span>
					) : null}
					<Icon
						icon={ChevronRight}
						size={12}
						className="absolute text-(--text-2) opacity-0 transition-[opacity,transform] duration-(--t) ease-(--ease) group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100"
						style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)' }}
					/>
				</span>
			</button>
				<span className="flex-1" />
				{children ? (
					// Stays while its menu is open, which Radix marks on the trigger.
				<div className="flex shrink-0 items-center opacity-0 group-focus-within/header:opacity-100 group-hover/header:opacity-100 has-data-[state=open]:opacity-100">
					{children}
				</div>
			) : null}
		</div>
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
	const spaceName = useSpaceName(session.spaceId);
	// A thread names its project where a task names its repository: one place, in words.
	const details = [show.repo && (spaceName ?? (session.repo ? repoName(session.repo) : 'Chat')), show.time && age(activeAt(session)), show.spend && session.usage.cost > 0 && dollars(session.usage.cost)].filter(
		(part): part is string => Boolean(part),
	);
	return (
		<div className="flex min-w-0 items-center gap-1.5 text-micro text-(--text-3)">
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
type TaskRowProps = { session: Session; place: Place; view: TaskView; active: boolean; onNavigate: () => void };

const TaskRow = memo(function TaskRow({ session, place, view, active, onNavigate }: TaskRowProps) {
	const [renaming, setRenaming] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [cardOpen, setCardOpen] = useState(false);
	// Its actions and menu are made the first time the pointer or focus reaches the row, so a long list mounts and updates as plain rows.
	const [armed, setArmed] = useState(false);
	// A task you just started slides in; one already listed when the page loads does not.
	const [arriving] = useState(() => isStarting(session.id));
	const note = taskNote(session);
	const live = isLive(session);
	return (
		<TaskPeek session={session} disabled={menuOpen || renaming || cardOpen}>
			<div
				data-open={menuOpen || undefined}
				onPointerEnter={armed ? undefined : () => setArmed(true)}
				onFocus={armed ? undefined : () => setArmed(true)}
				className={cn('group relative flex items-center rounded-control hover:bg-(--bg-hover)', view.compact ? 'h-7' : 'h-10', arriving && 'in-row-enter')}
			>
				{active ? <div className="absolute inset-0 rounded-control bg-(--bg-active)" /> : null}
				{renaming ? (
					<div className="relative flex min-w-0 flex-1 px-1">
						<TitleInput session={session} onDone={() => setRenaming(false)} className="min-w-0 flex-1" />
					</div>
				) : (
					<>
						{session.spaceId ? (
							<Link
								to="/projects/$spaceId/threads/$threadId"
								params={{ spaceId: session.spaceId, threadId: session.id }}
								onClick={onNavigate}
								aria-label={session.title}
								className="absolute inset-0 rounded-control outline-none focus-visible:shadow-(--focus)"
							/>
						) : (
							<Link
								to="/agents/$sessionId"
								params={{ sessionId: session.id }}
								search={{ app: 'code' }}
								onClick={onNavigate}
								aria-label={session.title}
								className="absolute inset-0 rounded-control outline-none focus-visible:shadow-(--focus)"
							/>
						)}
						<div
							className={cn(
								'pointer-events-none relative flex h-full min-w-0 flex-1 items-center gap-2 px-2',
								active || live ? 'text-(--text)' : 'text-(--text-2) group-hover:text-(--text)',
							)}
						>
							<span className={cn('inline-flex shrink-0', !view.compact && 'self-start pt-1', live && 'text-(--accent-text)')}>
															<TaskStatusIcon session={session} size={14} />
							</span>
							<div className="flex min-w-0 flex-1 flex-col gap-px">
								<span className="truncate text-body">{session.title}</span>
								{view.compact ? null : <Subtitle session={session} show={view.show} onCardChange={setCardOpen} />}
							</div>
							{/* Compact rows have no line for what waits on you, so a dot says it; it gives way to the row's actions on hover. */}
							{view.compact && note?.attention ? (
								<span
									role="img"
									aria-label={note.text}
									className={cn(
										'size-1.5 shrink-0 rounded-full group-focus-within:hidden group-hover:hidden group-data-open:hidden',
										note.tone === 'danger' ? 'bg-(--bad)' : 'bg-(--warn)',
									)}
								/>
							) : null}
						</div>
					</>
				)}
				{renaming || !armed ? null : (
					<div className="relative hidden shrink-0 items-center gap-px pr-1 group-focus-within:flex group-hover:flex group-data-open:flex">
						<HoverActions session={session} place={place} />
						<TaskMenu session={session} size="xs" side="right" onRename={() => setRenaming(true)} onOpenChange={setMenuOpen} />
					</div>
				)}
			</div>
		</TaskPeek>
	);
}, sameRow);

/**
 * A row draws again only when what it shows changed. The list's tasks are new objects whenever
 * one is added above them (the cache shares unchanged values by position, and every task moved
 * down one), so a task is compared field by field: its nested values are still shared when equal.
 */
function sameRow(before: TaskRowProps, after: TaskRowProps): boolean {
	if (before.place !== after.place || before.view !== after.view || before.active !== after.active || before.onNavigate !== after.onNavigate) return false;
	if (before.session === after.session) return true;
	const keys = Object.keys(after.session) as Array<keyof Session>;
	return keys.length === Object.keys(before.session).length && keys.every((key) => Object.is(before.session[key], after.session[key]));
}

/** A section's rows, under a heading per repository when grouping. */
function Rows({ tasks, place, view, activeId, onNavigate }: { tasks: Session[]; place: Place; view: TaskView; activeId?: string; onNavigate: () => void }) {
	return (
		<div className="flex flex-col gap-px">
			{groups(tasks, view.group).map((group) => (
				<div key={group.key} className="flex flex-col gap-px">
					{group.label ? <div className="truncate px-2 pt-1.5 pb-0.5 text-micro text-(--text-4)">{group.label}</div> : null}
					{group.tasks.map((session) => (
						<TaskRow key={session.id} session={session} place={place} view={view} active={activeId === session.id} onNavigate={onNavigate} />
					))}
				</div>
			))}
		</div>
	);
}

/** Rows of Recent drawn at first, and added by each Show more. */
const RECENT_PAGE = 50;

function Empty({ children }: { children: ReactNode }) {
	return <div className="px-2 py-1 text-small text-(--text-4)">{children}</div>;
}

export function ChatSidebar({
	open,
	collapsed,
	onNavigate,
	onCollapse,
	onOpenPalette,
	onOpenNotifications,
}: {
	/** Shown as a sheet over the page, on a phone. */
	open: boolean;
	/** Slid away to the rail, on a wider screen. */
	collapsed: boolean;
	onNavigate: () => void;
	onCollapse: () => void;
	onOpenPalette: () => void;
	/** The bell left of the sidebar toggle opens the Notifications dialog. */
	onOpenNotifications: () => void;
}) {
	const params = useParams({ strict: false }) as { sessionId?: string; spaceId?: string; threadId?: string };
	const inProject = Boolean(params.spaceId);
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
	const { pinned, running, recent } = useMemo(() => sections(sessions, view, query), [sessions, view, query]);
	// Recent draws a page of rows at a time, so a long history costs what it shows; the Tasks page lists them all.
	const [recentShown, setRecentShown] = useState(RECENT_PAGE);
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
			data-open={open}
			data-collapsed={collapsed}
			className="sg-nav flex w-[min(288px,86vw)] min-w-0 shrink-0 flex-col bg-(--bg-app) p-2 md:w-[236px]"
		>
			<div className="mb-1 flex h-9 shrink-0 items-center gap-0.5 pl-0.5">
				<Link to="/" onClick={onNavigate} aria-label="Anton: home" className="flex h-7 min-w-0 items-center gap-2 rounded-control px-1.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)">
					<Logo size={18} />
					<span className="truncate text-body font-semibold text-(--text)">Anton</span>
				</Link>
				<div className="min-w-1 flex-1" />
				<IconBtn icon={Search} size="sm" label="Search or jump to" onClick={onOpenPalette} />
				<NotificationsBell size="sm" onOpen={onOpenNotifications} />
				<IconBtn icon={PanelLeft} size="sm" label="Hide sidebar" onClick={onCollapse} className="hidden md:inline-flex" />
				<IconBtn icon={X} size="sm" label="Close sidebar" onClick={onNavigate} className="md:hidden" />
			</div>

			<Link
				{...(params.spaceId ? { to: '/projects/$spaceId' as const, params: { spaceId: params.spaceId }, search: { new: true } } : { to: '/' as const })}
				onClick={onNavigate}
				className="sg-btn sg-btn--secondary mb-2 shrink-0 justify-start"
			>
				<Icon icon={inProject ? Waypoints : SquarePen} size={14} />
				<span>{inProject ? 'New thread' : 'New task'}</span>
			</Link>

			{params.spaceId ? <ProjectSidebarBody spaceId={params.spaceId} threadId={params.threadId} onNavigate={onNavigate} /> : null}
			<nav aria-label="Pages" className={cn('flex shrink-0 flex-col gap-px', inProject && 'hidden')}>
				<Link to="/" onClick={onNavigate} activeOptions={{ exact: true }} className={NAV_ROW}>
					<NavIcon icon={Home} />
					<span className="min-w-0 flex-1 truncate">Home</span>
				</Link>
				<Link to="/tasks" onClick={onNavigate} className={NAV_ROW}>
					<NavIcon icon={List} />
					<span className="min-w-0 flex-1 truncate">Tasks</span>
					{sessions.length ? <Count>{sessions.length}</Count> : null}
				</Link>
				<Link to="/reviews" onClick={onNavigate} className={NAV_ROW}>
					<NavIcon icon={GitPullRequest} />
					<span className="min-w-0 flex-1 truncate">Reviews</span>
				</Link>
				<Link to="/projects" onClick={onNavigate} className={NAV_ROW}>
					<NavIcon icon={FolderKanban} />
					<span className="min-w-0 flex-1 truncate">Projects</span>
				</Link>
				<Link to="/artifacts" onClick={onNavigate} className={NAV_ROW}>
					<NavIcon icon={Shapes} />
					<span className="min-w-0 flex-1 truncate">Artifacts</span>
				</Link>
			</nav>

			<div className={cn('-mr-2 flex min-h-0 flex-1 flex-col overflow-y-auto pr-2 *:shrink-0', inProject && 'hidden')}>
				<ProjectsSection onNavigate={onNavigate} />
				<Toolbar view={view} onChange={changeView} tasks={sessions} query={query} onQuery={setQuery} />
				{pinned.length ? (
					<section aria-label="Pinned">
						<SectionHeader {...header('pinned', 'Pinned', pinned.length)} />
						{folded('pinned') ? null : rows(pinned, 'pinned')}
					</section>
				) : null}
				<section aria-label="Running">
					<SectionHeader {...header('running', 'Running', running.length)} />
					{folded('running') ? null : sessionsQuery.isError ? (
						<div className="px-2 py-1.5 text-small text-(--bad)">Could not load tasks.</div>
					) : sessionsQuery.isPending ? (
						<div className="h-10 rounded-control bg-(--bg-hover)" />
					) : running.length ? (
						rows(running, 'running')
					) : (
						<Empty>{narrowed ? 'Nothing running matches.' : 'Nothing is running.'}</Empty>
					)}
				</section>
				<section aria-label="Recent">
					<SectionHeader {...header('recent', 'Recent', recent.length)} />
					{folded('recent') ? null : recent.length ? (
						<>
							{rows(recent.length > recentShown ? recent.slice(0, recentShown) : recent, 'recent')}
							{recent.length > recentShown ? (
								<button type="button" onClick={() => setRecentShown((shown) => shown + RECENT_PAGE)} className={cn(NAV_ROW, 'mt-0.5 w-full font-normal text-(--text-3)')}>
									Show {Math.min(RECENT_PAGE, recent.length - recentShown)} more
								</button>
							) : null}
						</>
					) : (
						<Empty>{narrowed ? 'No stopped task matches.' : 'Stopped tasks show up here.'}</Empty>
					)}
				</section>
				<div className="h-3 shrink-0" />
			</div>

			<div className="-mx-2 -mb-2 flex shrink-0 flex-col gap-1.5 border-t border-(--line) px-3.5 pt-2 pb-2.5">
				<SpentToday />
				<div className="flex items-center gap-2">
					<Avatar name={name} />
					<div className="min-w-0 flex-1 truncate text-small font-medium text-(--text)">{name}</div>
					<button
						type="button"
						onClick={() => {
							onNavigate?.();
							openSettings();
						}}
						aria-label="Settings"
						title="Settings"
						className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm"
					>
						<Icon icon={Settings} size={14} />
					</button>
				</div>
			</div>
		</aside>
	);
}
