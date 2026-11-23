import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ChevronRight, ChevronsUpDown, LayoutGrid, ListFilter, Plus, Search, Settings, Waypoints, X } from '@/lib/icons';
import { type ReactNode, useEffect, useState } from 'react';
import { PrStatus, prTone } from '@/components/marks/pr-status';
import { ProjectIcon } from '@/components/marks/project-icon';
import { Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, SearchField, SectionLabel } from '@/components/kit/signal';
import { CompactViewItem, FacetSubmenus, FilterChips } from '@/components/shell/task-filters';
import { TaskPeek } from '@/components/shell/task-peek';
import { ThreadStateIcon } from '@/components/projects/thread-card';
import { Glyph } from '@/components/marks/thread-glyph';
import { repoShort, type Session } from '@/lib/api/sessions';
import type { Space, ThreadState } from '@/lib/api/spaces';
import { when } from '@/lib/format';
import { groupByState, STATE_LOOK, threadActiveAt, useSpaces, useThreads } from '@/lib/spaces';
import { openProjectSettings } from '@/lib/project-settings-modal';
import { DEFAULT_VIEW, FACET_KEYS, type FacetKey, filterCount, matches, readView, saveView, taskNote, type TaskView, toggleIn } from '@/lib/task-view';
import { cn } from '@/lib/utils';

export function SpaceMark({ space, size = 24, className }: { space: Pick<Space, 'name' | 'icon'>; size?: number; className?: string }) {
	return <ProjectIcon value={space.icon} name={space.name} size={size} className={className} />;
}

function SpaceSignal({ space }: { space: Space }) {
	if (space.counts.waiting) {
		return (
			<span title={`${space.counts.waiting} waiting on you`} className="in-num inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-(--warn-soft) px-1 text-nano text-(--warn)">
				{space.counts.waiting}
			</span>
		);
	}
	if (space.counts.working) return <Glyph kind="working" size={13} title={`${space.counts.working} working`} />;
	return null;
}

const ROW =
	'group/row relative flex min-w-0 shrink-0 items-center gap-2 rounded-control px-2 text-(--text-2) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)';

const LIFTED = 'data-[status=active]:bg-(--bg-active) data-[status=active]:text-(--text)';

export function SidebarHeading({ label, count, open, onToggle, children }: { label: string; count?: number; open: boolean; onToggle: () => void; children?: ReactNode }) {
	return (
		<div className="group/header mt-2 flex h-6 items-center gap-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="group/fold flex h-6 min-w-0 items-center gap-1.5 rounded-control px-2 text-(--text-3) outline-none hover:text-(--text-2) focus-visible:shadow-(--focus)"
			>
				<SectionLabel className="truncate">{label}</SectionLabel>
				{count ? <span className="in-num text-micro text-(--text-4)">{count}</span> : null}
				<Icon icon={ChevronRight} size={12} className="text-(--text-3) transition-transform" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
			</button>
			<span className="flex-1" />
			{children}
		</div>
	);
}

/** With `onToggle` the name folds the group away. */
export function GroupHeading({ label, count, open = true, onToggle, children, className }: { label: string; count?: number; open?: boolean; onToggle?: () => void; children?: ReactNode; className?: string }) {
	const name = (
		<>
			<span className="truncate">{label}</span>
			{count ? <span className="in-num font-normal text-(--text-4)">{count}</span> : null}
			{onToggle ? (
				<Icon
					icon={ChevronRight}
					size={11}
					className="text-(--text-4) opacity-0 transition-[opacity,transform] duration-(--t) group-hover/group:opacity-100 group-focus-within/group:opacity-100"
					style={{ transform: open ? 'rotate(90deg)' : undefined }}
				/>
			) : null}
		</>
	);
	const look = 'flex h-6 min-w-0 shrink-0 items-center gap-1.5 text-small font-medium text-(--text-3)';
	return (
		<div className={cn('group/group mt-3 flex h-6 items-center gap-1 pl-2', className)}>
			{onToggle ? (
				<button type="button" aria-expanded={open} onClick={onToggle} className={cn(look, 'rounded-control outline-none hover:text-(--text) focus-visible:shadow-(--focus)')}>
					{name}
				</button>
			) : (
				<h2 className={cn(look, 'm-0')}>{name}</h2>
			)}
			<span className="flex-1" />
			{children ? (
				<span className="flex shrink-0 items-center opacity-0 transition-opacity duration-(--t-fast) group-focus-within/group:opacity-100 group-hover/group:opacity-100 has-data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100">
					{children}
				</span>
			) : null}
		</div>
	);
}

export function ProjectsSection({ onNavigate }: { onNavigate: () => void }) {
	const spaces = useSpaces();
	const [open, setOpen] = useState(true);
	const list = (spaces.data?.spaces ?? []).filter((space) => space.state !== 'archived');
	if (!spaces.data) return null;
	return (
		<section aria-label="Projects" className="flex flex-col">
			<GroupHeading label="Projects" count={list.length} open={open} onToggle={() => setOpen((current) => !current)}>
				<Link to="/projects" search={{ create: true }} onClick={onNavigate} aria-label="New project" title="New project" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--xs">
					<Icon icon={Plus} size={12} />
				</Link>
			</GroupHeading>
			{open ? (
				<div className="flex flex-col gap-px">
					{list.map((space) => (
						<Link key={space.id} to="/projects/$spaceId" params={{ spaceId: space.id }} onClick={onNavigate} className={cn(ROW, LIFTED, 'h-7')}>
							<SpaceMark space={space} size={15} />
							<span className="min-w-0 flex-1 truncate text-body font-medium">{space.name}</span>
							<SpaceSignal space={space} />
						</Link>
					))}
					{list.length === 0 ? (
						<Link to="/projects" search={{ create: true }} onClick={onNavigate} className="rounded-control px-2 py-1 text-small text-(--text-4) hover:bg-(--bg-hover) hover:text-(--text-3)">
							Group work and run threads in parallel.
						</Link>
					) : null}
				</div>
			) : null}
		</section>
	);
}

function ThreadRow({ thread, active, repos, compact, onNavigate }: { thread: Session; active: boolean; repos: number; compact: boolean; onNavigate: () => void }) {
	const state = thread.threadState ?? 'idle';
	const note = taskNote(thread);
	return (
		<TaskPeek session={thread} disabled={false}>
			<Link
				to="/projects/$spaceId/threads/$threadId"
				params={{ spaceId: thread.spaceId ?? '', threadId: thread.id }}
				onClick={onNavigate}
				aria-current={active ? 'page' : undefined}
				className={cn(ROW, compact ? 'h-7' : 'h-10', active && 'text-(--text)', state === 'working' && 'text-(--text)')}
			>
				{active ? <span aria-hidden className="absolute inset-0 rounded-control bg-(--bg-active)" /> : null}
				<span className={cn('relative inline-flex shrink-0', !compact && 'self-start pt-1')}>
					<ThreadStateIcon thread={thread} size={14} />
				</span>
				<span className="relative flex min-w-0 flex-1 flex-col gap-px">
					<span className="truncate text-body">{thread.title}</span>
					{compact ? null : (
						<span className={cn('flex min-w-0 items-center gap-1.5 text-micro', state === 'waiting' ? 'text-(--warn)' : 'text-(--text-3)')}>
							<PrStatus thread={thread} />
							<span className="min-w-0 truncate">
								{state === 'waiting' && thread.asking ? thread.asking : [repos > 1 && repoShort(thread), when(threadActiveAt(thread))].filter(Boolean).join(' · ')}
							</span>
						</span>
					)}
				</span>
				{/* Compact rows have no line for what waits on you, so a dot says it. */}
				{compact && note?.attention ? (
					<span
						role="img"
						aria-label={note.text}
						className={cn(
							'relative size-1.5 shrink-0 rounded-full',
							note.tone === 'conflict' || (note.pullRequest && note.tone === 'danger')
								? undefined
								: note.tone === 'danger'
									? 'bg-(--bad)'
									: 'bg-(--warn)',
						)}
						style={
							note.tone === 'conflict'
								? { background: prTone('conflicts') }
								: note.pullRequest && note.tone === 'danger'
									? { background: prTone('failing') }
									: undefined
						}
					/>
				) : null}
			</Link>
		</TaskPeek>
	);
}

/** Threads narrow by these; their state is what the sections already group by. */
const THREAD_FACETS = FACET_KEYS.filter((key) => key !== 'status');

function ThreadsToolbar({
	threads,
	shown,
	filters,
	onToggle,
	onClear,
	compact,
	onToggleCompact,
	query,
	onQuery,
}: {
	threads: Session[];
	shown: number;
	filters: TaskView['filters'];
	onToggle: (key: FacetKey, value: string) => void;
	onClear: () => void;
	compact: boolean;
	onToggleCompact: () => void;
	query: string;
	onQuery: (next: string) => void;
}) {
	const [searching, setSearching] = useState(false);
	const close = () => {
		onQuery('');
		setSearching(false);
	};
	const open = searching || Boolean(query);
	const active = filterCount(filters);
	const actions = (
		<>
			{open ? <IconBtn icon={X} size="xs" label="Close search" onClick={close} /> : <IconBtn icon={Search} size="xs" label="Search threads" onClick={() => setSearching(true)} />}
			<Menu>
				<MenuTrigger asChild>
					<IconBtn icon={ListFilter} size="xs" label="Filter threads" className={cn(active > 0 && 'text-(--accent-text)')} />
				</MenuTrigger>
				<MenuContent side="right" align="start" sideOffset={6} className="w-[224px]">
					<FacetSubmenus filters={filters} onToggle={onToggle} tasks={threads} keys={THREAD_FACETS} />
					<MenuSeparator />
					<CompactViewItem compact={compact} onToggle={onToggleCompact} />
					<MenuSeparator />
					<MenuItem icon={X} disabled={active === 0} onSelect={onClear}>
						Clear filters
					</MenuItem>
				</MenuContent>
			</Menu>
		</>
	);
	if (open) {
		return (
			<div className="mt-3 flex h-6 shrink-0 items-center gap-1 pl-0.5">
				<SearchField size="sm" autoFocus value={query} onChange={onQuery} onEscape={close} placeholder="Search threads" className="flex-1" />
				<span className="-my-1 flex shrink-0 items-center">{actions}</span>
			</div>
		);
	}
	if (active) {
		return (
			<div className="mt-3 flex min-h-6 items-center gap-1 pl-2">
				<FilterChips filters={filters} onToggle={onToggle} tasks={threads} />
				<span className="flex shrink-0 items-center">{actions}</span>
			</div>
		);
	}
	return (
		<GroupHeading label="Threads" count={shown}>
			{actions}
		</GroupHeading>
	);
}

function StateGroup({ state, threads, activeId, repos, compact, onNavigate }: { state: ThreadState; threads: Session[]; activeId?: string; repos: number; compact: boolean; onNavigate: () => void }) {
	const [open, setOpen] = useState(state !== 'resolved' || threads.some((thread) => thread.id === activeId));
	const active = threads.some((thread) => thread.id === activeId);
	useEffect(() => { if (active) setOpen(true); }, [active, activeId]);
	const look = STATE_LOOK[state];
	return (
		<section aria-label={look.label} className="flex flex-col">
			<SidebarHeading
				label={look.label}
				count={threads.length}
				open={open}
				onToggle={() => setOpen((current) => !current)}
			/>
			{open ? (
				<div className="flex flex-col gap-px">
					{threads.map((thread) => (
						<ThreadRow key={thread.id} thread={thread} active={thread.id === activeId} repos={repos} compact={compact} onNavigate={onNavigate} />
					))}
				</div>
			) : null}
		</section>
	);
}

/** One line, so collapsed it is an icon the size of the rows around it. Its menu is the way out of the project. */
export function ProjectSwitcher({ spaceId, collapsed = false, onNavigate }: { spaceId: string; collapsed?: boolean; onNavigate: () => void }) {
	const navigate = useNavigate();
	const spaces = useSpaces();
	const space = spaces.data?.spaces.find((item) => item.id === spaceId);
	const go = (to: () => Promise<void>) => {
		onNavigate();
		void to();
	};
	const name = space?.name ?? 'Project';
	const counts = space ? `${space.repos.length} repo${space.repos.length === 1 ? '' : 's'} · ${space.threads} thread${space.threads === 1 ? '' : 's'}` : '';
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					title={[collapsed ? name : '', counts].filter(Boolean).join(' · ') || undefined}
					className="sg-nav-pin group/switch mb-1.5 flex h-8 shrink-0 items-center gap-2 rounded-control px-[7px] text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus) data-[state=open]:bg-(--bg-active)"
				>
					{space ? <SpaceMark space={space} size={18} className="shrink-0" /> : <span className="size-[18px] shrink-0" />}
					<span className="sg-nav-label min-w-0 flex-1 truncate text-body font-semibold text-(--text)">{name}</span>
					<Icon icon={ChevronsUpDown} size={13} className="sg-nav-label shrink-0 text-(--text-4) group-hover/switch:text-(--text-2)" />
				</button>
			</MenuTrigger>
			<MenuContent side={collapsed ? 'right' : 'bottom'} align="start" sideOffset={collapsed ? 10 : 4} className="w-[220px]">
				{(spaces.data?.spaces ?? [])
					.filter((item) => item.state !== 'archived')
					.map((item) => (
						<MenuItem key={item.id} checked={item.id === spaceId} hint={item.counts.waiting || undefined} onSelect={() => go(() => navigate({ to: '/projects/$spaceId', params: { spaceId: item.id } }))}>
							<span className="flex min-w-0 items-center gap-2">
								<SpaceMark space={item} size={14} />
								<span className="truncate">{item.name}</span>
							</span>
						</MenuItem>
					))}
				<MenuSeparator />
				<MenuItem icon={Settings} onSelect={() => openProjectSettings(spaceId)}>
					Project settings
				</MenuItem>
				<MenuItem icon={Plus} onSelect={() => go(() => navigate({ to: '/projects', search: { create: true } }))}>
					New project
				</MenuItem>
				<MenuSeparator />
				<MenuItem icon={LayoutGrid} onSelect={() => go(() => navigate({ to: '/projects' }))}>
					All projects
				</MenuItem>
				<MenuItem icon={ArrowLeft} onSelect={() => go(() => navigate({ to: '/' }))}>
					All tasks
				</MenuItem>
			</MenuContent>
		</Menu>
	);
}

export function ProjectSidebarBody({
	spaceId,
	threadId,
	collapsed = false,
	compact: controlledCompact,
	onCompactChange,
	onNavigate,
}: {
	spaceId: string;
	threadId?: string;
	collapsed?: boolean;
	compact?: boolean;
	onCompactChange?: (compact: boolean) => void;
	onNavigate: () => void;
}) {
	const spaces = useSpaces();
	const { threads } = useThreads(spaceId);
	const space = spaces.data?.spaces.find((item) => item.id === spaceId);
	// Each project keeps its own filters while the page is open; a search is for the project in front of you.
	const [filtersBy, setFiltersBy] = useState<Record<string, TaskView['filters']>>({});
	const [localCompact, setLocalCompact] = useState(() => readView().compact);
	const compact = controlledCompact ?? localCompact;
	const toggleCompact = () => {
		const next = !compact;
		if (onCompactChange) onCompactChange(next);
		else {
			setLocalCompact(next);
			saveView({ ...readView(), compact: next });
		}
	};
	const [query, setQuery] = useState('');
	useEffect(() => setQuery(''), [spaceId]);
	const filters = filtersBy[spaceId] ?? DEFAULT_VIEW.filters;
	const setFilters = (next: TaskView['filters']) => setFiltersBy((current) => ({ ...current, [spaceId]: next }));
	const words = query.trim().toLowerCase();
	const shown = threads.filter((thread) => matches(thread, filters) && (!words || thread.title.toLowerCase().includes(words)));
	const narrowed = shown.length !== threads.length;
	const groups = groupByState(shown);
	const coordinatorActive = !threadId;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="-mr-2 flex min-h-0 flex-1 flex-col overflow-y-auto pr-2 pb-2">
				<div>
					<Link
						to="/projects/$spaceId"
						params={{ spaceId }}
						onClick={onNavigate}
						aria-current={coordinatorActive ? 'page' : undefined}
						title={collapsed ? 'Coordinator' : undefined}
						className={cn(ROW, 'sg-nav-pin h-7', coordinatorActive && 'text-(--text)')}
					>
						{coordinatorActive ? <span aria-hidden className="absolute inset-0 rounded-control bg-(--bg-active)" /> : null}
						<span className="relative inline-flex shrink-0 items-center justify-center text-(--accent-text)">
							<Icon icon={Waypoints} size={15} />
						</span>
						<span className="sg-nav-label relative min-w-0 flex-1 truncate text-body font-medium">Coordinator</span>
					</Link>
				</div>
				<div className="sg-nav-more flex flex-col">
					{threads.length ? (
						<ThreadsToolbar
							threads={threads}
							shown={shown.length}
							filters={filters}
							onToggle={(key, value) => setFilters(toggleIn(filters, key, value))}
							onClear={() => setFilters(DEFAULT_VIEW.filters)}
							compact={compact}
							onToggleCompact={toggleCompact}
							query={query}
							onQuery={setQuery}
						/>
					) : null}
					{groups.map((group) => (
						<StateGroup key={group.state} state={group.state} threads={group.threads} activeId={threadId} repos={space?.repos.length ?? 1} compact={compact} onNavigate={onNavigate} />
					))}
					{threads.length === 0 ? (
						<div className="px-2 pt-2 text-small text-(--text-4)">Threads the coordinator or you start show here, by state.</div>
					) : narrowed && shown.length === 0 ? (
						<div className="px-2 pt-2 text-small text-(--text-4)">No thread matches.</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
