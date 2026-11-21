import { useFlueAgent } from '@flue/react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ChevronRight, FolderGit2, Maximize2, Minimize2, PanelRight, Plus, Settings, Waypoints, Workflow } from '@/lib/icons';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { PanelTab, PanelTabs, Status } from '@/components/kit/instrument';
import { MenuButton } from '@/components/kit/nav';
import { ProjectBoard } from '@/components/projects/project-board';
import { ProjectFeed } from '@/components/projects/project-feed';
import { ProjectActivity, ProjectFiles, ProjectPullRequests, ProjectRoutines } from '@/components/projects/project-panel';
import { SpaceMark } from '@/components/projects/project-sidebar';
import { useModelName, useModels } from '@/lib/models';
import { startingPanels, TaskWorkspace, type TaskPanels } from '@/components/shell/shell';
import { Badge, Btn, EmptyState, Icon, IconBtn } from '@/components/kit/signal';
import { useOnePane } from '@/lib/one-pane';
import { useOlderTurns, useWindowedClient } from '@/lib/conversation-window';
import { readThreadPanels, saveThreadPanels, useSpace, useThreads } from '@/lib/spaces';
import { useStarting } from '@/lib/starting';
import { StartingTask } from '@/components/thread/starting-task';
import { usePaneSlide } from '@/components/workspace/workspace-pane';
import { openProjectSettings } from '@/lib/project-settings-modal';
import { cn } from '@/lib/utils';

type ProjectView = 'board' | 'files' | 'activity' | 'prs' | 'routines';

const VIEWS: Array<{ id: ProjectView; label: string }> = [
	{ id: 'board', label: 'Board' },
	{ id: 'files', label: 'Files' },
	{ id: 'activity', label: 'Activity' },
	{ id: 'prs', label: 'Pull requests' },
	{ id: 'routines', label: 'Routines' },
];

/** The tabs the right panel had before the board: their names map onto the views. */
const LEGACY_VIEW: Record<string, ProjectView> = { Overview: 'activity', Library: 'files', 'Pull requests': 'prs', Routines: 'routines' };

type DockState = { open: boolean; view: ProjectView };

const dockKey = (spaceId: string) => `anton.project-panel.${spaceId}`;

const DOCK_KEY = 'anton.project-dock-width';
const DOCK_DEFAULT = 380;
const DOCK_MIN = 320;
/** The width the board keeps beside the dock when it is dragged wider. */
const DOCK_RESERVE = 360;

function savedDockWidth(): number | null {
	try {
		const value = Number(localStorage.getItem(DOCK_KEY));
		return Number.isFinite(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

function readDock(spaceId: string): DockState {
	try {
		const saved = JSON.parse(localStorage.getItem(dockKey(spaceId)) ?? 'null') as { open?: boolean; view?: string; tab?: string } | null;
		const view = VIEWS.some((item) => item.id === saved?.view) ? (saved!.view as ProjectView) : (LEGACY_VIEW[saved?.tab ?? ''] ?? 'board');
		return { open: saved?.open ?? true, view };
	} catch {
		return { open: true, view: 'board' };
	}
}

function saveDock(spaceId: string, state: DockState) {
	try {
		localStorage.setItem(dockKey(spaceId), JSON.stringify(state));
	} catch {
		// Storage is a convenience; the dock still works without it.
	}
}

export function ProjectPage() {
	const { spaceId } = useParams({ from: '/projects/$spaceId' });
	const search = useSearch({ from: '/projects/$spaceId' });
	const navigate = useNavigate();
	const space = useSpace(spaceId);
	const { threads } = useThreads(spaceId);
	const path = `/api/agents/coordinator/${spaceId}`;
	const client = useWindowedClient(path);
	const agent = useOlderTurns(path, client, useFlueAgent({ client }));
	const [saved, setDock] = useState(() => readDock(spaceId));
	// On a phone the dock covers the board, so it shows only once you open it here; the saved choice is the wide screen's.
	const onePane = useOnePane();
	const [paneOpen, setPaneOpen] = useState(false);
	const dockOpen = onePane ? paneOpen : saved.open;
	const [expanded, setExpanded] = useState(false);
	const [starting, setStarting] = useState(Boolean(search.new));
	const [row, setRow] = useState<HTMLDivElement | null>(null);
	const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
	const [available, setAvailable] = useState(0);
	const [requested, setRequested] = useState(savedDockWidth);
	const [resizing, setResizing] = useState(false);
	const asked = useRef(false);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	const models = useModels();
	const modelName = useModelName();
	const coordinatorModel = space.data?.coordinatorModel ?? models.data?.default ?? '';
	const coordinatorName = coordinatorModel ? modelName(coordinatorModel) : '';
	const slide = usePaneSlide(dockOpen);

	useLayoutEffect(() => {
		if (!row) return;
		const measure = () => setAvailable(Math.round(row.getBoundingClientRect().width));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(row);
		return () => observer.disconnect();
	}, [row]);

	const changeDock = useCallback(
		(next: Partial<DockState>) => {
			if (onePane && next.open !== undefined) {
				setPaneOpen(next.open);
				if (!next.open) setExpanded(false);
				const { open: _open, ...rest } = next;
				next = rest;
			}
			setDock((current) => {
				const updated = { ...current, ...next };
				saveDock(spaceId, updated);
				if (!updated.open) setExpanded(false);
				return updated;
			});
		},
		[spaceId, onePane],
	);

	// A first message from the New project dialog goes to the coordinator once, then leaves the address.
	useEffect(() => {
		if (!search.ask || asked.current || !agent.historyReady) return;
		asked.current = true;
		void agent.sendMessage(search.ask);
		void navigate({ to: '/projects/$spaceId', params: { spaceId }, search: {}, replace: true });
	}, [search.ask, agent.historyReady]);

	// The new thread's form opens in the coordinator's conversation, so the board or view beside it stays.
	const startThread = useCallback(() => {
		setStarting(true);
		changeDock({ open: true });
	}, [changeDock]);

	useEffect(() => {
		if (search.new) {
			startThread();
			void navigate({ to: '/projects/$spaceId', params: { spaceId }, search: {}, replace: true });
		}
	}, [search.new]);

	if (space.isError) {
		return <EmptyState icon={Waypoints} title="No such project" body="It may have been deleted. Projects are listed in the sidebar." className="mt-24" />;
	}
	if (!space.data) return <div className="flex-1" />;
	const data = space.data;
	const centerVisible = !(dockOpen && (onePane || expanded));
	// Expanded or on a phone the dock covers the board, so it has no width of its own to keep.
	const covers = expanded || onePane;
	const minimum = Math.min(DOCK_MIN, available);
	const maximum = Math.max(minimum, available - DOCK_RESERVE);
	const clamp = (value: number) => Math.round(Math.min(maximum, Math.max(minimum, value)));
	const dockWidth = available ? clamp(requested ?? DOCK_DEFAULT) : DOCK_DEFAULT;
	const chooseDock = (value: number) => {
		const next = clamp(value);
		setRequested(next);
		try {
			localStorage.setItem(DOCK_KEY, String(next));
		} catch {
			// Resizing also works when browser storage is unavailable.
		}
	};

	return (
		<div ref={setRow} className="flex min-h-0 min-w-0 flex-1">
			<div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !centerVisible && 'hidden')}>
				<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-3 pl-2 md:pl-4">
					<MenuButton />
					<nav aria-label="Where you are" className="flex min-w-0 shrink-0 items-center gap-1.5 text-body">
						<Link to="/projects" className="shrink-0 rounded-control text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
							Projects
						</Link>
						<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--text-4)" />
						<SpaceMark space={data} size={16} />
						<span className="min-w-0 truncate font-medium text-(--text)">{data.name}</span>
						{busy ? (
							<Status tone="accent" pulse>
								Coordinating
							</Status>
						) : data.state !== 'active' ? (
							<Status tone="warning">{data.state === 'paused' ? 'Paused' : 'Archived'}</Status>
						) : null}
					</nav>
					<PanelTabs label="Project views" className="min-w-0 flex-1">
						{VIEWS.map((view) => (
							<PanelTab key={view.id} on={saved.view === view.id} onSelect={() => changeDock({ view: view.id })}>
								{view.label}
							</PanelTab>
						))}
					</PanelTabs>
					<div className="hidden shrink-0 items-center gap-1 xl:flex">
						{data.repos.slice(0, 4).map((repo) => (
							<span key={repo.id} title={repo.repoFullName} className="inline-flex h-[20px] max-w-[140px] min-w-0 items-center gap-1 rounded-inner px-1.5 text-micro font-medium text-(--text-3) shadow-[inset_0_0_0_1px_var(--line-strong)]">
								<Icon icon={FolderGit2} size={10} className="shrink-0" />
								<span className="truncate">{repo.repoFullName.split('/').pop()}</span>
							</span>
						))}
					</div>
					<IconBtn icon={Settings} size="sm" label="Project settings" onClick={() => openProjectSettings(spaceId)} />
					<Btn size="sm" variant="primary" icon={Waypoints} onClick={startThread}>
						<span className="hidden sm:inline">New thread</span>
					</Btn>
					{!dockOpen ? <IconBtn icon={PanelRight} size="sm" label="Show the coordinator" onClick={() => changeDock({ open: true })} /> : null}
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{saved.view === 'board' ? (
						<ProjectBoard threads={threads} onNewThread={startThread} />
					) : (
						<div className="mx-auto flex h-full w-full max-w-[960px] flex-col gap-3 px-4 py-4 md:px-6">
							{saved.view === 'files' ? <ProjectFiles space={data} threads={threads} /> : null}
							{saved.view === 'activity' ? <ProjectActivity space={data} threads={threads} /> : null}
							{saved.view === 'prs' ? <ProjectPullRequests threads={threads} /> : null}
							{saved.view === 'routines' ? <ProjectRoutines space={data} threads={threads} /> : null}
						</div>
					)}
				</div>
			</div>
			{slide ? (
			<aside
				className={cn(
					'min-h-0 min-w-0 flex-col',
					covers ? cn('flex flex-1', slide === 'out' && 'hidden') : 'sg-project-dock relative flex border-l bg-(--bg-app)',
				)}
				data-slide={covers ? undefined : slide}
				data-resizing={resizing || undefined}
				style={covers ? undefined : ({ '--dock-width': available ? `${dockWidth}px` : `${DOCK_DEFAULT}px` } as CSSProperties)}
			>
				{!covers && slide === 'still' ? (
					<div
						role="separator"
						aria-label="Resize the coordinator"
						aria-orientation="vertical"
						aria-valuemin={minimum}
						aria-valuemax={maximum}
						aria-valuenow={dockWidth}
						aria-valuetext={`${dockWidth} pixels`}
						tabIndex={0}
						className="sg-workspace-resizer absolute inset-y-0 left-0 z-20 hidden w-1.5 cursor-col-resize touch-none outline-none md:block"
						onKeyDown={(event) => {
							const next = { ArrowLeft: dockWidth + 24, ArrowRight: dockWidth - 24, Home: minimum, End: maximum }[event.key];
							if (next === undefined) return;
							event.preventDefault();
							chooseDock(next);
						}}
						onPointerDown={(event) => {
							if (event.button !== 0) return;
							event.preventDefault();
							event.currentTarget.focus();
							event.currentTarget.setPointerCapture(event.pointerId);
							drag.current = { pointer: event.pointerId, x: event.clientX, width: dockWidth };
							setResizing(true);
						}}
						onPointerMove={(event) => {
							const start = drag.current;
							if (start?.pointer === event.pointerId) chooseDock(start.width + start.x - event.clientX);
						}}
						onPointerUp={(event) => {
							if (drag.current?.pointer !== event.pointerId) return;
							event.currentTarget.releasePointerCapture(event.pointerId);
							drag.current = null;
							setResizing(false);
						}}
						onLostPointerCapture={() => {
							drag.current = null;
							setResizing(false);
						}}
					/>
				) : null}
				<div className="sg-project-dock-body flex min-h-0 min-w-0 flex-1 flex-col">
				<div className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-2 pl-3.5">
					<Icon icon={Workflow} size={14} className="shrink-0 text-(--text-3)" />
					<span className="min-w-0 flex-1 truncate text-body font-medium text-(--text)">Coordinator</span>
					{coordinatorName ? (
						<span className="hidden shrink-0 sm:inline-flex">
							<Badge>{coordinatorName}</Badge>
						</span>
					) : null}
					<IconBtn
						icon={expanded ? Minimize2 : Maximize2}
						size="sm"
						label={expanded ? 'Restore the board' : 'Expand the coordinator'}
						onClick={() => setExpanded((current) => !current)}
						className="hidden md:inline-flex"
					/>
					<IconBtn icon={PanelRight} size="sm" label="Hide the coordinator" onClick={() => changeDock({ open: false })} />
				</div>
				<ProjectFeed space={data} agent={agent} threads={threads} starting={starting} onStartingChange={setStarting} />
				</div>
			</aside>
			) : null}
		</div>
	);
}

function typing(event: KeyboardEvent): boolean {
	const target = event.target as HTMLElement | null;
	if (!target || event.defaultPrevented) return true;
	if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .xterm')) return true;
	return Boolean(document.querySelector('[role="dialog"], [role="menu"]'));
}

/** Its workspace panels are kept per thread, so switching back finds them as they were. Escape goes back to the coordinator. */
export function ThreadPage() {
	const { spaceId, threadId } = useParams({ from: '/projects/$spaceId/threads/$threadId' });
	const search = useSearch({ from: '/projects/$spaceId/threads/$threadId' });
	const navigate = useNavigate();
	const space = useSpace(spaceId);
	const starting = useStarting(threadId);
	// Each time it opens, a thread shows the panels you pinned; whether its workspace was open is its own.
	const [panels, setPanels] = useState<TaskPanels>(() => {
		const start = startingPanels();
		return { ...start, open: readThreadPanels(threadId, start).open };
	});

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.key !== 'Escape' || typing(event)) return;
			void navigate({ to: '/projects/$spaceId', params: { spaceId } });
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [spaceId]);

	const leading = (
		<>
			<Link
				to="/projects/$spaceId"
				params={{ spaceId }}
				title="Back to the coordinator (Esc)"
				className="flex min-w-0 shrink items-center gap-1.5 rounded-control py-0.5 pr-1 text-body text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)"
			>
				{space.data ? <SpaceMark space={space.data} size={16} /> : null}
				<span className="hidden max-w-[160px] truncate sm:inline">{space.data?.name ?? 'Project'}</span>
			</Link>
			<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--text-4)" />
		</>
	);
	if (starting) return <StartingTask starting={starting} workspace={panels.open} narrow={panels.active === null} leading={leading} onDiscard={() => void navigate({ to: '/projects/$spaceId', params: { spaceId } })} />;
	return (
		<TaskWorkspace
			sessionId={threadId}
			panels={panels}
			onPanelsChange={(next) => {
				setPanels(next);
				saveThreadPanels(threadId, next);
				if (search.panel) void navigate({ to: '/projects/$spaceId/threads/$threadId', params: { spaceId, threadId }, search: {}, replace: true });
			}}
			panelRequest={search.panel}
			leading={leading}
		/>
	);
}
