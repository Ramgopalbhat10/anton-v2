import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ChevronRight, ChevronsUpDown, FolderKanban, LayoutGrid, Plus, Settings, Waypoints } from 'lucide-react';
import { useState } from 'react';
import { Count } from '@/components/instrument';
import { Icon, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, SectionLabel, Spinner } from '@/components/signal';
import { ThreadStateIcon } from '@/components/thread-card';
import type { Session, Space, ThreadState } from '@/lib/api';
import { age } from '@/lib/format';
import { groupByState, STATE_LOOK, spaceMark, threadActiveAt, useSpaces, useThreads } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/** A project's mark on a small tile: its emoji, or its initial in the accent. */
export function SpaceMark({ space, size = 24 }: { space: Pick<Space, 'name' | 'icon'>; size?: number }) {
	return (
		<span
			aria-hidden
			className="inline-flex shrink-0 items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--well-bg) font-medium text-(--accent-text)"
			style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
		>
			{spaceMark(space)}
		</span>
	);
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
	if (space.counts.working) return <Spinner size={11} />;
	return null;
}

const ROW =
	'group/row relative flex min-w-0 items-center gap-2 rounded-[10px] pr-2 pl-2 text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)';

/** The projects in the main sidebar, under Tasks and Reviews: each with what waits on you. */
export function ProjectsSection({ onNavigate }: { onNavigate: () => void }) {
	const spaces = useSpaces();
	const [open, setOpen] = useState(true);
	const list = (spaces.data?.spaces ?? []).filter((space) => space.state !== 'archived');
	if (!spaces.data) return null;
	return (
		<section aria-label="Projects" className="flex flex-col">
			<div className="group/header mt-2 flex h-7 items-center gap-0.5 pr-1.5 pl-2">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((current) => !current)}
					className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-(--text-tertiary) outline-none hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring)"
				>
					<Icon icon={FolderKanban} size={12} className="text-(--icon-tertiary)" />
					<SectionLabel className="truncate">Projects</SectionLabel>
					<Icon icon={ChevronRight} size={12} className="text-(--icon-tertiary) opacity-0 transition-transform group-hover/header:opacity-100" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
				</button>
				<Link to="/projects" search={{ create: true }} onClick={onNavigate} aria-label="New project" title="New project" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--xs opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100">
					<Icon icon={Plus} size={12} />
				</Link>
			</div>
			{open ? (
				<div className="flex flex-col gap-0.5 px-2">
					{list.map((space) => (
						<Link key={space.id} to="/projects/$spaceId" params={{ spaceId: space.id }} onClick={onNavigate} className={cn(ROW, 'h-8')} activeProps={{ 'data-active': true } as object}>
							<SpaceMark space={space} size={20} />
							<span className="min-w-0 flex-1 truncate text-[13px]">{space.name}</span>
							<SpaceSignal space={space} />
						</Link>
					))}
					{list.length === 0 ? (
						<Link to="/projects" search={{ create: true }} onClick={onNavigate} className="mx-0 mt-0.5 rounded-[10px] border border-dashed border-(--border-default) px-3 py-2 text-[12px] text-(--text-disabled) hover:text-(--text-tertiary)">
							Group repositories and run threads in parallel.
						</Link>
					) : null}
				</div>
			) : null}
		</section>
	);
}

/** A thread in the project sidebar: its state as an icon, title, and repository and age under it. */
function ThreadRow({ thread, active, onNavigate }: { thread: Session; active: boolean; onNavigate: () => void }) {
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
			{state === 'working' ? <span aria-hidden className="absolute top-2.5 bottom-2.5 -left-2 w-[2px] rounded-full bg-(--accent-base)" /> : null}
			<span className="relative inline-flex shrink-0 self-start pt-[7px]">
				<ThreadStateIcon thread={thread} size={13} />
			</span>
			<span className="relative flex min-w-0 flex-1 flex-col gap-px">
				<span className="truncate text-[13px]">{thread.title}</span>
				<span className={cn('truncate text-[11px]', state === 'waiting' ? 'text-(--warning-text)' : 'text-(--text-tertiary)')}>
					{state === 'waiting' && thread.asking ? thread.asking : `${thread.repo.split('/').pop()} · ${age(threadActiveAt(thread))}`}
				</span>
			</span>
		</Link>
	);
}

/** A state's threads under its mono label and count; Resolved starts folded. */
function StateGroup({ state, threads, activeId, onNavigate }: { state: ThreadState; threads: Session[]; activeId?: string; onNavigate: () => void }) {
	const [open, setOpen] = useState(state !== 'resolved');
	const look = STATE_LOOK[state];
	return (
		<section aria-label={look.label} className="flex flex-col">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
				className="group/fold mt-2 flex h-7 items-center gap-1.5 rounded-md px-4 text-left text-(--text-tertiary) outline-none hover:text-(--text-secondary)"
			>
				<span className={cn('in-caption', state === 'waiting' && 'text-(--warning-text)', state === 'working' && 'text-(--accent-text)')}>{look.label}</span>
				<span className="in-num text-[11px] text-(--text-disabled)">{threads.length}</span>
				<span className="flex-1" />
				<Icon icon={ChevronRight} size={12} className="text-(--icon-tertiary) opacity-0 transition-transform group-hover/fold:opacity-100" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
			</button>
			{open ? (
				<div className="flex flex-col gap-0.5 px-2">
					{threads.map((thread) => (
						<ThreadRow key={thread.id} thread={thread} active={thread.id === activeId} onNavigate={onNavigate} />
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
			<div className="flex flex-col gap-1 px-2 pb-1">
				<Link to="/" onClick={onNavigate} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-(--text-tertiary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)">
					<Icon icon={ArrowLeft} size={12} />
					All tasks
				</Link>
				<Menu>
					<MenuTrigger asChild>
						<button
							type="button"
							className="flex h-10 items-center gap-2.5 rounded-[10px] border border-(--border-subtle) bg-(--well-bg) pr-2 pl-1.5 text-left outline-none hover:border-(--border-default) focus-visible:shadow-(--focus-ring)"
						>
							{space ? <SpaceMark space={space} size={26} /> : <span className="size-[26px]" />}
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate text-[13px] font-medium text-(--text-primary)">{space?.name ?? 'Project'}</span>
								<span className="in-num truncate text-[10.5px] text-(--text-tertiary)">
									{space ? `${space.repos.length} repo${space.repos.length === 1 ? '' : 's'} · ${space.threads} thread${space.threads === 1 ? '' : 's'}` : ' '}
								</span>
							</span>
							<Icon icon={ChevronsUpDown} size={13} className="text-(--icon-tertiary)" />
						</button>
					</MenuTrigger>
					<MenuContent align="start" className="w-[232px]">
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
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
				<div className="px-2 pt-1">
					<Link
						to="/projects/$spaceId"
						params={{ spaceId }}
						onClick={onNavigate}
						aria-current={coordinatorActive ? 'page' : undefined}
						className={cn(ROW, 'h-10', coordinatorActive && 'text-(--text-primary)')}
					>
						{coordinatorActive ? <span aria-hidden className="absolute inset-0 rounded-[10px] border border-(--card-border) bg-(--card-bg-top) shadow-(--card-highlight)" /> : null}
						<span className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] border border-(--accent-border) bg-(--accent-bg-subtle) text-(--accent-text)">
							<Icon icon={Waypoints} size={13} />
						</span>
						<span className="relative flex min-w-0 flex-1 flex-col">
							<span className="truncate text-[13px]">Coordinator</span>
							<span className="truncate text-[11px] text-(--text-tertiary)">plans, starts and tracks threads</span>
						</span>
						{space?.counts.waiting ? (
							<span className="relative">
								<Count>{space.counts.waiting}</Count>
							</span>
						) : null}
					</Link>
				</div>
				{groups.map((group) => (
					<StateGroup key={group.state} state={group.state} threads={group.threads} activeId={threadId} onNavigate={onNavigate} />
				))}
				{threads.length === 0 ? (
					<div className="mx-2 mt-3 rounded-[10px] border border-dashed border-(--border-default) px-3 py-2 text-[12px] text-(--text-disabled)">Threads the coordinator or you start show here, by state.</div>
				) : null}
			</div>
		</div>
	);
}
