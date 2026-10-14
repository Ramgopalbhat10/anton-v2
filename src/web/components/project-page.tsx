import { useFlueAgent } from '@flue/react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { PanelRight, Settings, Waypoints } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Status } from '@/components/instrument';
import { MenuButton } from '@/components/nav';
import { ProjectFeed } from '@/components/project-feed';
import { PROJECT_TABS, ProjectPanel, type ProjectTab } from '@/components/project-panel';
import { SpaceMark } from '@/components/project-sidebar';
import { DEFAULT_PANELS, TaskWorkspace, type TaskPanels } from '@/components/shell';
import { Btn, EmptyState, Icon, IconBtn } from '@/components/signal';
import { useOnePane } from '@/lib/one-pane';
import { readThreadPanels, saveThreadPanels, useSpace, useThreads } from '@/lib/spaces';
import { cn } from '@/lib/utils';

type ProjectPanelState = { open: boolean; tab: ProjectTab };

const panelKey = (spaceId: string) => `anton.project-panel.${spaceId}`;

function readProjectPanel(spaceId: string): ProjectPanelState {
	try {
		const saved = JSON.parse(localStorage.getItem(panelKey(spaceId)) ?? 'null') as Partial<ProjectPanelState> | null;
		const tab = PROJECT_TABS.find((item) => item.name === saved?.tab)?.name ?? 'Overview';
		return { open: saved?.open ?? true, tab };
	} catch {
		return { open: true, tab: 'Overview' };
	}
}

function saveProjectPanel(spaceId: string, state: ProjectPanelState) {
	try {
		localStorage.setItem(panelKey(spaceId), JSON.stringify(state));
	} catch {
		// Storage is a convenience; the panel still works without it.
	}
}

/**
 * A project with its coordinator selected: the coordinator's conversation in
 * the middle, and the project's own panels (Overview, Library, pull
 * requests, routines) on the right.
 */
export function ProjectPage() {
	const { spaceId } = useParams({ from: '/projects/$spaceId' });
	const search = useSearch({ from: '/projects/$spaceId' });
	const navigate = useNavigate();
	const space = useSpace(spaceId);
	const { threads } = useThreads(spaceId);
	const agent = useFlueAgent({ url: `/api/agents/coordinator/${spaceId}` });
	const [saved, setPanel] = useState(() => readProjectPanel(spaceId));
	// On a phone the panel covers the coordinator, so it shows only once you open it here; the saved choice is the wide screen's.
	const onePane = useOnePane();
	const [paneOpen, setPaneOpen] = useState(false);
	const panel = { ...saved, open: onePane ? paneOpen : saved.open };
	const [expanded, setExpanded] = useState(false);
	const [starting, setStarting] = useState(Boolean(search.new));
	const asked = useRef(false);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';

	// Kept to one identity each, so the memoized panel skips the renders the coordinator's stream causes.
	const changePanel = useCallback(
		(next: Partial<ProjectPanelState>) => {
			if (onePane && next.open !== undefined) {
				setPaneOpen(next.open);
				if (!next.open) setExpanded(false);
				const { open: _open, ...rest } = next;
				next = rest;
			}
			setPanel((current) => {
				const updated = { ...current, ...next };
				saveProjectPanel(spaceId, updated);
				if (!updated.open) setExpanded(false);
				return updated;
			});
		},
		[spaceId, onePane],
	);
	const changeTab = useCallback((tab: ProjectTab) => changePanel({ tab }), [changePanel]);
	const closePanel = useCallback(() => changePanel({ open: false }), [changePanel]);
	const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

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
	const centerVisible = !(panel.open && expanded);

	return (
		<div className="@container/workspace flex min-h-0 min-w-0 flex-1">
			<div className={cn('min-h-0 min-w-0 flex-1 flex-col', !centerVisible ? 'hidden' : panel.open ? 'hidden @min-[700px]/workspace:flex' : 'flex')}>
				<header className="flex h-11 shrink-0 items-center gap-2 pr-3 pl-2 md:pl-4">
					<MenuButton />
					<SpaceMark space={data} size={22} />
					<h1 className="m-0 min-w-0 truncate text-[13.5px] font-medium text-(--text-primary)">{data.name}</h1>
					{busy ? (
						<Status tone="accent" pulse>
							Coordinating
						</Status>
					) : data.state !== 'active' ? (
						<Status tone="warning">{data.state === 'paused' ? 'Paused' : 'Archived'}</Status>
					) : null}
					<div className="min-w-0 flex-1" />
					<Btn size="sm" variant="ghost" icon={Waypoints} onClick={() => setStarting(true)}>
						<span className="hidden sm:inline">New thread</span>
					</Btn>
					<Link to="/projects/$spaceId/settings" params={{ spaceId }} aria-label="Project settings" title="Project settings" className="sg-btn sg-icon-btn sg-btn--ghost sg-btn--sm">
						<Icon icon={Settings} size={14} />
					</Link>
					{!panel.open ? <IconBtn icon={PanelRight} size="sm" label="Show the project panel" onClick={() => changePanel({ open: true })} /> : null}
				</header>
				<ProjectFeed space={data} agent={agent} threads={threads} starting={starting} onStartingChange={setStarting} />
			</div>
			{panel.open ? (
				<ProjectPanel
					space={data}
					threads={threads}
					tab={panel.tab}
					onTab={changeTab}
					expanded={expanded}
					onToggleExpanded={toggleExpanded}
					onClose={closePanel}
				/>
			) : null}
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
	const [panels, setPanels] = useState<TaskPanels>(() => readThreadPanels(threadId, DEFAULT_PANELS));

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.key !== 'Escape' || typing(event)) return;
			void navigate({ to: '/projects/$spaceId', params: { spaceId } });
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [spaceId]);

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
			leading={
				<>
					<Link
						to="/projects/$spaceId"
						params={{ spaceId }}
						title="Back to the coordinator (Esc)"
						className="flex min-w-0 shrink items-center gap-1.5 rounded-md py-0.5 pr-1 text-[12.5px] text-(--text-tertiary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
					>
						{space.data ? <SpaceMark space={space.data} size={18} /> : null}
						<span className="hidden max-w-[160px] truncate sm:inline">{space.data?.name ?? 'Project'}</span>
					</Link>
					<span aria-hidden className="text-(--text-disabled)">
						/
					</span>
				</>
			}
		/>
	);
}
