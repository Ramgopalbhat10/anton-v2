import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ChevronRight, ChevronsUpDown, LayoutGrid, Plus, Settings, Waypoints } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { PrStatus } from '@/components/pr-status';
import { ProjectIcon } from '@/components/project-icon';
import { Icon, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, SectionLabel } from '@/components/signal';
import { ThreadStateIcon } from '@/components/thread-card';
import { Glyph } from '@/components/thread-glyph';
import { repoShort, type Session, type Space, type ThreadState } from '@/lib/api';
import { age } from '@/lib/format';
import { groupByState, STATE_LOOK, threadActiveAt, useSpaces, useThreads } from '@/lib/spaces';
import { openProjectSettings } from '@/lib/project-settings-modal';
import { cn } from '@/lib/utils';

/** A project's mark: its icon on a tinted tile, or its initial when it has none. */
export function SpaceMark({ space, size = 24, className }: { space: Pick<Space, 'name' | 'icon'>; size?: number; className?: string }) {
	return <ProjectIcon value={space.icon} name={space.name} size={size} className={className} />;
}

/** The amber count of threads waiting on you, or a spinner while threads work. */
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

/** The page you are on, lifted out as a small card. */
const LIFTED = 'data-[status=active]:bg-(--bg-active) data-[status=active]:text-(--text)';

/** A sidebar section's heading: its label and count in quiet type, and actions on hover. */
export function SidebarHeading({ label, count, open, onToggle, tone, children }: { label: string; count?: number; open: boolean; onToggle: () => void; tone?: string; children?: ReactNode }) {
	return (
		<div className="group/header mt-2 flex h-6 items-center gap-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="group/fold flex h-6 min-w-0 items-center gap-1.5 rounded-control px-2 text-(--text-3) outline-none hover:text-(--text-2) focus-visible:shadow-(--focus)"
			>
				<SectionLabel className={cn('truncate', tone)}>{label}</SectionLabel>
				{count ? <span className="in-num text-micro text-(--text-4)">{count}</span> : null}
				<Icon icon={ChevronRight} size={12} className="text-(--text-3) transition-transform" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
			</button>
			<span className="flex-1" />
			{children}
		</div>
	);
}

/**
 * A top-level group of the sidebar (Projects, Tasks): its name in small
 * capitals, its count, and a hairline running to its actions, so the sections
 * inside it (Running, Recent) read as its children. With `onToggle` the name
 * folds the group away.
 */
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
			{/* Its actions wait for the pointer or the keyboard, and stay while a menu of theirs is open. */}
			{children ? (
				<span className="flex shrink-0 items-center opacity-0 transition-opacity duration-(--t-fast) group-focus-within/group:opacity-100 group-hover/group:opacity-100 has-data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100">
					{children}
				</span>
			) : null}
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
			<GroupHeading label="Projects" count={list.length} open={open} onToggle={() => setOpen((current) => !current)}>
				<Link to="/projects" search={{ create: true }} onClick={onNavigate} aria-label="New project" title="New project" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--xs">
					<Icon icon={Plus} size={12} />
				</Link>
			</GroupHeading>
			{open ? (
				<div className="flex flex-col gap-px">
					{list.map((space) => (
						<Link key={space.id} to="/projects/$spaceId" params={{ spaceId: space.id }} onClick={onNavigate} className={cn(ROW, LIFTED, 'h-7')}>
							<SpaceMark space={space} size={16} />
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

/** A thread in the project sidebar: its state as an icon, its title, and under it what it asks you or how long since it moved (and its repository when the project has several). */
function ThreadRow({ thread, active, repos, onNavigate }: { thread: Session; active: boolean; repos: number; onNavigate: () => void }) {
	const state = thread.threadState ?? 'idle';
	return (
		<Link
			to="/projects/$spaceId/threads/$threadId"
			params={{ spaceId: thread.spaceId ?? '', threadId: thread.id }}
			onClick={onNavigate}
			aria-current={active ? 'page' : undefined}
			className={cn(ROW, 'h-10', active && 'text-(--text)', state === 'working' && 'text-(--text)')}
		>
			{active ? <span aria-hidden className="absolute inset-0 rounded-control bg-(--bg-active)" /> : null}
			<span className="relative inline-flex shrink-0 self-start pt-1">
							<ThreadStateIcon thread={thread} size={14} />
			</span>
			<span className="relative flex min-w-0 flex-1 flex-col gap-px">
				<span className="truncate text-body">{thread.title}</span>
				<span className={cn('flex min-w-0 items-center gap-1.5 text-micro', state === 'waiting' ? 'text-(--warn)' : 'text-(--text-3)')}>
					<PrStatus thread={thread} />
					<span className="min-w-0 truncate">
					{state === 'waiting' && thread.asking ? thread.asking : [repos > 1 && repoShort(thread), age(threadActiveAt(thread))].filter(Boolean).join(' · ')}
					</span>
				</span>
			</span>
		</Link>
	);
}

/** A state's threads under its mono label and count; Resolved starts folded. */
function StateGroup({ state, threads, activeId, repos, onNavigate }: { state: ThreadState; threads: Session[]; activeId?: string; repos: number; onNavigate: () => void }) {
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
				tone={state === 'waiting' ? 'text-(--warn)' : state === 'working' ? 'text-(--accent-text)' : state === 'review' || state === 'landing' ? 'text-(--ok)' : undefined}
			/>
			{open ? (
				<div className="flex flex-col gap-px">
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
			<div className="flex flex-col gap-1.5 pb-1">
				<div className="flex h-6 items-center gap-1">
					<Link to="/" onClick={onNavigate} className="flex h-6 items-center gap-1.5 rounded-control px-1.5 text-small text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
						<Icon icon={ArrowLeft} size={12} />
						All tasks
					</Link>
					<span className="text-small text-(--text-4)">/</span>
					<Link to="/projects" onClick={onNavigate} className="flex h-6 items-center rounded-control px-1.5 text-small text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
						Projects
					</Link>
				</div>
				<Menu>
					<MenuTrigger asChild>
						<button
							type="button"
							className="flex flex-col rounded-control bg-(--bg-hover) p-1.5 text-left shadow-[inset_0_0_0_1px_var(--line)] outline-none hover:bg-(--bg-active) focus-visible:shadow-(--focus) data-[state=open]:bg-(--bg-active)"
						>
							<span className="flex w-full min-w-0 items-center gap-2.5">
								{space ? <SpaceMark space={space} size={26} /> : <span className="size-[26px]" />}
																<span className="flex min-w-0 flex-1 flex-col gap-px">
																	<span className="truncate text-body font-semibold text-(--text)">{space?.name ?? 'Project'}</span>
									<span className="in-num truncate text-micro text-(--text-3)">
										{space ? `${space.repos.length} repo${space.repos.length === 1 ? '' : 's'} · ${space.threads} thread${space.threads === 1 ? '' : 's'}` : ' '}
									</span>
								</span>
								<Icon icon={ChevronsUpDown} size={14} className="text-(--text-3)" />
							</span>
						</button>
					</MenuTrigger>
					<MenuContent align="start" className="w-[220px]">
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
						<MenuItem icon={Settings} onSelect={() => openProjectSettings(spaceId)}>
							Project settings
						</MenuItem>
					</MenuContent>
				</Menu>
			</div>
			<div className="-mr-2 flex min-h-0 flex-1 flex-col overflow-y-auto pr-2 pb-2">
				<div className="pt-1.5">
					<Link
						to="/projects/$spaceId"
						params={{ spaceId }}
						onClick={onNavigate}
						aria-current={coordinatorActive ? 'page' : undefined}
						className={cn(ROW, 'h-7', coordinatorActive && 'text-(--text)')}
					>
						{coordinatorActive ? <span aria-hidden className="absolute inset-0 rounded-control bg-(--bg-active)" /> : null}
						<span className="relative inline-flex shrink-0 items-center justify-center text-(--accent-text)">
							<Icon icon={Waypoints} size={15} />
						</span>
						<span className="relative min-w-0 flex-1 truncate text-body font-medium">Coordinator</span>
					</Link>
				</div>
				{groups.map((group) => (
					<StateGroup key={group.state} state={group.state} threads={group.threads} activeId={threadId} repos={space?.repos.length ?? 1} onNavigate={onNavigate} />
				))}
				{threads.length === 0 ? (
					<div className="px-2 pt-2 text-small text-(--text-4)">Threads the coordinator or you start show here, by state.</div>
				) : null}
			</div>
		</div>
	);
}
