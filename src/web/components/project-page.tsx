import { useFlueAgent } from '@flue/react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { PanelRight, Settings, Waypoints } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Caption, Status } from '@/components/instrument';
import { MenuButton } from '@/components/nav';
import { ProjectFeed } from '@/components/project-feed';
import { PROJECT_TABS, ProjectPanel, type ProjectTab } from '@/components/project-panel';
import { SpaceMark } from '@/components/project-sidebar';
import { DEFAULT_PANELS, TaskWorkspace, type TaskPanels } from '@/components/shell';
import { Btn, EmptyState, Icon, IconBtn } from '@/components/signal';
import { ThreadStatePill } from '@/components/thread-card';
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

/** What the project is doing, in a few words: what needs you, then what works. */
function summary(counts: Record<string, number>): string {
	const parts = [
		counts.waiting ? `${counts.waiting} need${counts.waiting === 1 ? 's' : ''} you` : null,
		counts.working ? `${counts.working} working` : null,
		counts.queued ? `${counts.queued} queued` : null,
		counts.review + counts.landing ? `${counts.review + counts.landing} ready` : null,
	].filter(Boolean);
	return parts.length ? parts.join(' · ') : 'quiet';
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
	const [panel, setPanel] = useState(() => readProjectPanel(spaceId));
	const [expanded, setExpanded] = useState(false);
	const [starting, setStarting] = useState(Boolean(search.new));
	const asked = useRef(false);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';

	const changePanel = (next: Partial<ProjectPanelState>) =>
		setPanel((current) => {
			const updated = { ...current, ...next };
			saveProjectPanel(spaceId, updated);
			if (!updated.open) setExpanded(false);
			return updated;
		});

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
					<Caption className="hidden min-w-0 truncate md:block">{summary(data.counts)}</Caption>
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
					onTab={(tab) => changePanel({ tab })}
					expanded={expanded}
					onToggleExpanded={() => setExpanded((current) => !current)}
					onClose={() => changePanel({ open: false })}
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
	const { threads } = useThreads(spaceId);
	const thread = threads.find((item) => item.id === threadId);
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
					{thread && thread.threadState && thread.threadState !== 'working' ? (
						<span className="hidden shrink-0 lg:inline-flex">
							<ThreadStatePill thread={thread} compact />
						</span>
					) : null}
				</>
			}
		/>
	);
}
