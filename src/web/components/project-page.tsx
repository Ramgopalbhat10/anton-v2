import { useFlueAgent } from '@flue/react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ChevronRight, FolderGit2, Maximize2, Minimize2, PanelRight, Plus, Settings, Waypoints, Workflow } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelTab, PanelTabs, Status } from '@/components/instrument';
import { MenuButton } from '@/components/nav';
import { ProjectBoard } from '@/components/project-board';
import { NewThreadForm, ProjectFeed } from '@/components/project-feed';
import { ProjectActivity, ProjectFiles, ProjectPullRequests, ProjectRoutines } from '@/components/project-panel';
import { SpaceMark } from '@/components/project-sidebar';
import { useModelName, useModels } from '@/components/model-picker';
import { startingPanels, TaskWorkspace, type TaskPanels } from '@/components/shell';
import { Badge, Btn, EmptyState, Icon, IconBtn } from '@/components/signal';
import { useOnePane } from '@/lib/one-pane';
import { readThreadPanels, saveThreadPanels, useSpace, useThreads } from '@/lib/spaces';
import { useStarting } from '@/lib/starting';
import { StartingTask } from '@/components/starting-task';
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

/**
 * A project: its threads as a board by state in the main view, with the
 * coordinator docked on the right — it plans, starts threads and reports
 * back. Files, activity, pull requests and routines are views of the board.
 */
export function ProjectPage() {
	const { spaceId } = useParams({ from: '/projects/$spaceId' });
	const search = useSearch({ from: '/projects/$spaceId' });
	const navigate = useNavigate();
	const space = useSpace(spaceId);
	const { threads } = useThreads(spaceId);
	const agent = useFlueAgent({ url: `/api/agents/coordinator/${spaceId}` });
	const [saved, setDock] = useState(() => readDock(spaceId));
	// On a phone the dock covers the board, so it shows only once you open it here; the saved choice is the wide screen's.
	const onePane = useOnePane();
	const [paneOpen, setPaneOpen] = useState(false);
	const dockOpen = onePane ? paneOpen : saved.open;
	const [expanded, setExpanded] = useState(false);
	const [starting, setStarting] = useState(Boolean(search.new));
	const asked = useRef(false);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	const models = useModels();
	const modelName = useModelName();
	const coordinatorModel = space.data?.coordinatorModel ?? models.data?.default ?? '';
	const coordinatorName = coordinatorModel ? modelName(coordinatorModel) : '';

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

	useEffect(() => {
		if (search.new) {
			setStarting(true);
			void navigate({ to: '/projects/$spaceId', params: { spaceId }, search: {}, replace: true });
		}
	}, [search.new]);

	if (space.isError) {
		return <EmptyState icon={Waypoints} title="No such project" body="It may have been deleted. Projects are listed in the sidebar." className="mt-24" />;
	}
	if (!space.data) return <div className="flex-1" />;
	const data = space.data;
	const centerVisible = !(dockOpen && (onePane || expanded));

	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !centerVisible && 'hidden')}>
				<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-3 pl-2 md:pl-4">
					<MenuButton />
					<nav aria-label="Where you are" className="flex min-w-0 shrink-0 items-center gap-1.5 text-body">
						<Link to="/projects" className="shrink-0 rounded-control text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
							Projects
						</Link>
						<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--text-4)" />
						<SpaceMark space={data} size={18} />
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
					<Btn size="sm" variant="primary" icon={Waypoints} onClick={() => setStarting(true)}>
						<span className="hidden sm:inline">New thread</span>
					</Btn>
					{!dockOpen ? <IconBtn icon={PanelRight} size="sm" label="Show the coordinator" onClick={() => changeDock({ open: true })} /> : null}
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{starting && centerVisible ? (
						<div className="px-4 pt-[10vh]">
							<NewThreadForm space={data} onDone={() => setStarting(false)} />
						</div>
					) : saved.view === 'board' ? (
						<ProjectBoard threads={threads} onNewThread={() => setStarting(true)} />
					) : (
						<div className="mx-auto flex w-full max-w-[960px] flex-col gap-3 px-4 py-4 md:px-6">
							{saved.view === 'files' ? <ProjectFiles space={data} threads={threads} /> : null}
							{saved.view === 'activity' ? <ProjectActivity space={data} threads={threads} /> : null}
							{saved.view === 'prs' ? <ProjectPullRequests threads={threads} /> : null}
							{saved.view === 'routines' ? <ProjectRoutines space={data} threads={threads} /> : null}
						</div>
					)}
				</div>
			</div>
			<aside className={cn('min-h-0 min-w-0 flex-col border-(--line)', dockOpen ? cn('flex', onePane || expanded ? 'flex-1' : 'w-[380px] shrink-0 border-l bg-(--bg-app)') : 'hidden')}>
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
				{starting && !centerVisible ? (
					<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-[10vh]">
						<NewThreadForm space={data} onDone={() => setStarting(false)} />
					</div>
				) : (
					<ProjectFeed space={data} agent={agent} threads={threads} onStartingChange={setStarting} />
				)}
			</aside>
		</div>
	);
}

/** True when a key press is meant for a field, a menu or a dialog rather than the page. */
function typing(event: KeyboardEvent): boolean {
	const target = event.target as HTMLElement | null;
	if (!target || event.defaultPrevented) return true;
	if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .xterm')) return true;
	return Boolean(document.querySelector('[role="dialog"], [role="menu"]'));
}

/**
 * A project's thread in the main view: its own conversation and composer,
 * with its own workspace panels kept per thread, so switching back finds
 * them as they were. Escape goes back to the coordinator.
 */
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
				{space.data ? <SpaceMark space={space.data} size={18} /> : null}
				<span className="hidden max-w-[160px] truncate sm:inline">{space.data?.name ?? 'Project'}</span>
			</Link>
			<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--text-4)" />
		</>
	);
	// A thread you just started opens at once, as a skeleton until the server has made it.
	if (starting) return <StartingTask starting={starting} workspace={panels.open} leading={leading} onDiscard={() => void navigate({ to: '/projects/$spaceId', params: { spaceId } })} />;
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
