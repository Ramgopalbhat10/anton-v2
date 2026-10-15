import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ChevronRight, ChevronsUpDown, LayoutGrid, Plus, Settings, Waypoints } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ProjectIcon } from '@/components/project-icon';
import { Icon, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, SectionLabel } from '@/components/signal';
import { ThreadStateIcon } from '@/components/thread-card';
import { Glyph } from '@/components/thread-glyph';
import { repoShort, type Session, type Space, type ThreadState } from '@/lib/api';
import { age } from '@/lib/format';
import { groupByState, STATE_LOOK, threadActiveAt, useSpaces, useThreads } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/** A project's mark: its icon on a tinted tile, or its initial when it has none. */
export function SpaceMark({ space, size = 24, className }: { space: Pick<Space, 'name' | 'icon'>; size?: number; className?: string }) {
	return <ProjectIcon value={space.icon} name={space.name} size={size} className={className} />;
}

/** The amber count of threads waiting on you, or a spinner while threads work. */
function SpaceSignal({ space }: { space: Space }) {
	if (space.counts.waiting) {
		return (
			<span title={`${space.counts.waiting} waiting on you`} className="in-num inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-(--warning-bg) px-1 text-[10px] text-(--warning-text)">
				{space.counts.waiting}
			</span>
		);
	}
	if (space.counts.working) return <Glyph kind="working" size={13} title={`${space.counts.working} working`} />;
	return null;
}

const ROW =
	'group/row relative flex min-w-0 items-center gap-2.5 rounded-[10px] border border-transparent pr-2 pl-2 text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)';

/** The page you are on, lifted out as a small card. */
const LIFTED = 'data-[status=active]:border-(--card-border) data-[status=active]:bg-(--card-bg-top) data-[status=active]:text-(--text-primary) data-[status=active]:shadow-(--card-highlight)';

/** A sidebar section's heading: its label and count in quiet type, and actions on hover. */
export function SidebarHeading({ label, count, open, onToggle, tone, children }: { label: string; count?: number; open: boolean; onToggle: () => void; tone?: string; children?: ReactNode }) {
	return (
		<div className="group/header mt-2 flex h-7 items-center gap-1 pr-2.5 pl-3">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="group/fold flex h-6 min-w-0 items-center gap-1.5 rounded-md px-2 text-(--text-tertiary) outline-none hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring)"
			>
				<SectionLabel className={cn('truncate', tone)}>{label}</SectionLabel>
				{count ? <span className="in-num text-[11px] text-(--text-disabled)">{count}</span> : null}
				<Icon icon={ChevronRight} size={12} className="text-(--icon-tertiary) opacity-0 transition-transform group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
			</button>
			<span className="flex-1" />
			{children}
		</div>
	);
}

/** The projects in the main sidebar, under Tasks and Reviews: each with what waits on you. */
export function ProjectsSection({ onNavigate }: { onNavigate: () => void }) {
	const spaces = useSpaces();
	const [open, setOpen] = useState(true);
	const list = (spaces.data?.spaces ?? []).filter((space) => space.state !== 'archived');
	if (!spaces.data) return null;
	return (
		<section aria-label="Projects" className="flex flex-col">
			<SidebarHeading label="Projects" count={list.length} open={open} onToggle={() => setOpen((current) => !current)}>
				<Link to="/projects" search={{ create: true }} onClick={onNavigate} aria-label="New project" title="New project" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--xs opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100">
					<Icon icon={Plus} size={12} />
				</Link>
			</SidebarHeading>
			{open ? (
				<div className="flex flex-col gap-0.5 px-3">
					{list.map((space) => (
						<Link key={space.id} to="/projects/$spaceId" params={{ spaceId: space.id }} onClick={onNavigate} className={cn(ROW, LIFTED, 'h-9 pl-1.5')}>
							<SpaceMark space={space} size={24} />
							<span className="min-w-0 flex-1 truncate text-[13px]">{space.name}</span>
							<SpaceSignal space={space} />
						</Link>
					))}
					{list.length === 0 ? (
						<Link to="/projects" search={{ create: true }} onClick={onNavigate} className="mx-0 mt-0.5 rounded-[10px] border border-dashed border-(--border-default) px-3 py-2 text-[12px] text-(--text-disabled) hover:text-(--text-tertiary)">
							Group work and run threads in parallel.
						</Link>
					) : null}
				</div>
			) : null}
		</section>
	);
}

/** A thread in the project sidebar: its state as an icon, its title, and under it what it asks you or how long since it moved (and its repository when the project has several). */
function ThreadRow({ thread, active, repos, onNavigate }: { thread: Session; active: boolean; repos: number; onNavigate: () => void }) {
	const state = thread.threadState ?? 'idle';
	return (
		<Link
			to="/projects/$spaceId/threads/$threadId"
			params={{ spaceId: thread.spaceId ?? '', threadId: thread.id }}
			onClick={onNavigate}
			aria-current={active ? 'page' : undefined}
			className={cn(ROW, 'h-11', active && 'text-(--text-primary)', state === 'working' && 'text-(--text-primary)')}
		>
			{active ? <span aria-hidden className="absolute inset-0 rounded-[10px] border border-(--card-border) bg-(--card-bg-top) shadow-(--card-highlight)" /> : null}
			<span className="relative inline-flex shrink-0 self-start pt-[7px]">
				<ThreadStateIcon thread={thread} size={13} />
			</span>
			<span className="relative flex min-w-0 flex-1 flex-col gap-px">
				<span className="truncate text-[13px]">{thread.title}</span>
				<span className={cn('truncate text-[11px]', state === 'waiting' ? 'text-(--warning-text)' : 'text-(--text-tertiary)')}>
					{state === 'waiting' && thread.asking ? thread.asking : [repos > 1 && repoShort(thread), age(threadActiveAt(thread))].filter(Boolean).join(' · ')}
				</span>
			</span>
		</Link>
	);
}

/** A state's threads under its mono label and count; Resolved starts folded. */
function StateGroup({ state, threads, activeId, repos, onNavigate }: { state: ThreadState; threads: Session[]; activeId?: string; repos: number; onNavigate: () => void }) {
	const [open, setOpen] = useState(state !== 'resolved');
	const look = STATE_LOOK[state];
	return (
		<section aria-label={look.label} className="flex flex-col">
			<SidebarHeading
				label={look.label}
				count={threads.length}
				open={open}
				onToggle={() => setOpen((current) => !current)}
				tone={state === 'waiting' ? 'text-(--warning-text)' : state === 'working' ? 'text-(--accent-text)' : state === 'review' || state === 'landing' ? 'text-(--success-text)' : undefined}
			/>
			{open ? (
				<div className="flex flex-col gap-0.5 px-3">
					{threads.map((thread) => (
						<ThreadRow key={thread.id} thread={thread} active={thread.id === activeId} repos={repos} onNavigate={onNavigate} />
					))}
				</div>
			) : null}
		</section>
	);
}

/**
 * The sidebar inside a project: a switcher to other projects, the
 * coordinator pinned first, then the threads by state, what needs you on
 * top. "All tasks" goes back to the usual sidebar.
 */
export function ProjectSidebarBody({ spaceId, threadId, onNavigate }: { spaceId: string; threadId?: string; onNavigate: () => void }) {
	const navigate = useNavigate();
	const spaces = useSpaces();
	const { threads } = useThreads(spaceId);
	const space = spaces.data?.spaces.find((item) => item.id === spaceId);
	const groups = groupByState(threads);
	const coordinatorActive = !threadId;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex flex-col gap-1.5 px-3 pb-1">
				<div className="flex h-6 items-center gap-1">
					<Link to="/" onClick={onNavigate} className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-(--text-tertiary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)">
						<Icon icon={ArrowLeft} size={12} />
						All tasks
					</Link>
					<span className="text-[12px] text-(--text-disabled)">/</span>
					<Link to="/projects" onClick={onNavigate} className="flex h-6 items-center rounded-md px-1.5 text-[12px] text-(--text-tertiary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)">
						Projects
					</Link>
				</div>
				<Menu>
					<MenuTrigger asChild>
						<button
							type="button"
							className="flex flex-col rounded-[12px] border border-(--card-border) bg-[linear-gradient(180deg,var(--card-bg-top),var(--card-bg))] p-2.5 text-left shadow-(--card-highlight) outline-none hover:border-(--border-strong) focus-visible:shadow-(--focus-ring) data-[state=open]:border-(--border-strong)"
						>
							<span className="flex w-full min-w-0 items-center gap-2.5">
								{space ? <SpaceMark space={space} size={34} /> : <span className="size-[34px]" />}
								<span className="flex min-w-0 flex-1 flex-col gap-px">
									<span className="truncate text-[13.5px] font-medium text-(--text-primary)">{space?.name ?? 'Project'}</span>
									<span className="in-num truncate text-[11px] text-(--text-tertiary)">
										{space ? `${space.repos.length} repo${space.repos.length === 1 ? '' : 's'} · ${space.threads} thread${space.threads === 1 ? '' : 's'}` : ' '}
									</span>
								</span>
								<Icon icon={ChevronsUpDown} size={14} className="text-(--icon-tertiary)" />
							</span>
						</button>
					</MenuTrigger>
					<MenuContent align="start" className="w-[264px]">
						{(spaces.data?.spaces ?? [])
							.filter((item) => item.state !== 'archived')
							.map((item) => (
								<MenuItem key={item.id} checked={item.id === spaceId} hint={item.counts.waiting || undefined} onSelect={() => void navigate({ to: '/projects/$spaceId', params: { spaceId: item.id } })}>
									<span className="flex min-w-0 items-center gap-2">
										<SpaceMark space={item} size={18} />
										<span className="truncate">{item.name}</span>
									</span>
								</MenuItem>
							))}
						<MenuSeparator />
						<MenuItem icon={LayoutGrid} onSelect={() => void navigate({ to: '/projects' })}>
							All projects
						</MenuItem>
						<MenuItem icon={Plus} onSelect={() => void navigate({ to: '/projects', search: { create: true } })}>
							New project
						</MenuItem>
						<MenuItem icon={Settings} onSelect={() => void navigate({ to: '/projects/$spaceId/settings', params: { spaceId } })}>
							Project settings
						</MenuItem>
					</MenuContent>
				</Menu>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3">
				<div className="px-3 pt-1.5">
					<Link
						to="/projects/$spaceId"
						params={{ spaceId }}
						onClick={onNavigate}
						aria-current={coordinatorActive ? 'page' : undefined}
						className={cn(ROW, 'h-10 pl-1.5', coordinatorActive && 'text-(--text-primary)')}
					>
						{coordinatorActive ? <span aria-hidden className="absolute inset-0 rounded-[10px] border border-(--card-border) bg-(--card-bg-top) shadow-(--card-highlight)" /> : null}
						<span className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-(--accent-border) bg-(--accent-bg-subtle) text-(--accent-text)">
							<Icon icon={Waypoints} size={15} />
						</span>
						<span className="relative min-w-0 flex-1 truncate text-[13px]">Coordinator</span>
					</Link>
				</div>
				{groups.map((group) => (
					<StateGroup key={group.state} state={group.state} threads={group.threads} activeId={threadId} repos={space?.repos.length ?? 1} onNavigate={onNavigate} />
				))}
				{threads.length === 0 ? (
					<div className="mx-3 mt-3 rounded-[10px] border border-dashed border-(--border-default) px-3 py-2 text-[12px] text-(--text-disabled)">Threads the coordinator or you start show here, by state.</div>
				) : null}
			</div>
		</div>
	);
}
