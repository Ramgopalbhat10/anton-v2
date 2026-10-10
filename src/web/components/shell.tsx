import { type UseFlueAgentResult, useFlueAgent } from '@flue/react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { FileDiff, PanelRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ChatSidebar, SidebarRail } from '@/components/chat-sidebar';
import { CommandPalette } from '@/components/command-palette';
import { Launcher } from '@/components/launcher';
import { MenuButton, NavContext } from '@/components/nav';
import { Btn, IconBtn } from '@/components/signal';
import { PullRequestChip, TaskMenu, TaskTitle } from '@/components/task-actions';
import { Thread } from '@/components/thread';
import { type PanelName, VmPanel } from '@/components/vm-panel';
import { api, type Session } from '@/lib/api';
import { useLiveUpdates } from '@/lib/live-updates';
import { useTaskNotifications } from '@/lib/notifications';
import { SendToAgent } from '@/lib/review';
import { ShowPanel } from '@/lib/workspace';
import { cn } from '@/lib/utils';

function readCollapsed() {
	try {
		return localStorage.getItem('anton.sidebar') === 'collapsed';
	} catch {
		return false;
	}
}

export function AppShell() {
	const [navOpen, setNavOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const closePalette = useCallback(() => setPaletteOpen(false), []);
	useTaskNotifications();
	useLiveUpdates();

	useEffect(() => {
		try {
			localStorage.setItem('anton.sidebar', collapsed ? 'collapsed' : 'open');
		} catch {
			// Storage is a convenience; the sidebar still works without it.
		}
	}, [collapsed]);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				setPaletteOpen((current) => !current);
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	return (
		<NavContext.Provider value={() => setNavOpen(true)}>
			<div className="flex h-dvh overflow-hidden bg-(--bg-canvas) text-[13px] leading-[18px] text-(--text-primary)">
				{navOpen ? (
					<button
						type="button"
						aria-label="Close sidebar"
						className="fixed inset-0 z-20 bg-(--bg-scrim) md:hidden"
						onClick={() => setNavOpen(false)}
					/>
				) : null}
				{collapsed ? <SidebarRail onExpand={() => setCollapsed(false)} /> : null}
				<div className={collapsed ? 'contents md:hidden' : 'contents'}>
					<ChatSidebar
						open={navOpen}
						onNavigate={() => setNavOpen(false)}
						onCollapse={() => setCollapsed(true)}
						onOpenPalette={() => {
							setNavOpen(false);
							setPaletteOpen(true);
						}}
					/>
				</div>
				<main className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--bg-canvas)">
					<Outlet />
				</main>
				<CommandPalette open={paletteOpen} onClose={closePalette} />
			</div>
		</NavContext.Provider>
	);
}

export function HomePage() {
	return <Launcher />;
}

/** The agent opens and updates pull requests itself, through its open_pull_request tool. */
function pullRequestAsk(session: Session): string {
	return session.prUrl
		? 'Commit and push the latest changes to the pull request.'
		: 'Open a pull request with the changes on this branch. Write a clear title and a short description.';
}

type StatusTone = { label: string; text: string; dot: string };

/** Whether a message is handing work to the browser subagent right now. */
function handingToBrowser(message: UseFlueAgentResult['messages'][number] | undefined): boolean {
	return Boolean(
		message?.parts.some(
			(part) =>
				part.type === 'dynamic-tool' &&
				part.toolName === 'task' &&
				part.state === 'input-available' &&
				(part.input as { agent?: unknown } | undefined)?.agent === 'browser',
		),
	);
}

function statusFor(agent: UseFlueAgentResult): StatusTone | null {
	if (agent.status === 'submitted' || agent.status === 'streaming') {
		return { label: 'Working', text: 'text-(--accent-text)', dot: 'bg-(--accent-base)' };
	}
	const settled = agent.settlements[agent.settlements.length - 1];
	if (agent.status === 'error' || (settled && settled.outcome !== 'completed')) {
		return { label: settled?.outcome === 'aborted' ? 'Stopped' : 'Failed', text: 'text-(--danger-text)', dot: 'bg-(--danger-base)' };
	}
	if (agent.messages.length > 0) return { label: 'Finished', text: 'text-(--success-text)', dot: 'bg-(--success-base)' };
	return null;
}

/** Which workspace panels a task has open, which one shows, and whether the workspace is open at all. */
export type TaskPanels = { tabs: PanelName[]; active: PanelName | null; open: boolean };

export const DEFAULT_PANELS: TaskPanels = { tabs: ['Changes', 'Terminal', 'Files'], active: 'Changes', open: true };

/**
 * A task's conversation beside its workspace: the page for a task, and for a
 * project's thread. Where the panels' state lives (the address and the page,
 * or the browser per thread) is up to the page around it.
 */
export function TaskWorkspace({
	sessionId,
	panels,
	onPanelsChange,
	panelRequest,
	leading,
}: {
	sessionId: string;
	panels: TaskPanels;
	onPanelsChange: (next: TaskPanels) => void;
	/** A panel to open, such as History from the sidebar's Rewind; asking again opens it again. */
	panelRequest?: PanelName;
	/** Shown before the title, such as the project a thread belongs to. */
	leading?: ReactNode;
}) {
	const [expanded, setExpanded] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const session = useQuery({
		queryKey: ['session', sessionId],
		queryFn: () => api.session(sessionId),
	});
	const agent = useFlueAgent({ url: `/api/agents/coder/${sessionId}` });
	const status = statusFor(agent);
	const { open, tabs, active } = panels;
	const latest = useRef(panels);
	latest.current = panels;
	const change = (next: Partial<TaskPanels>) => onPanelsChange({ ...latest.current, ...next });

	function setOpen(next: boolean) {
		if (!next) setExpanded(false);
		change({ open: next });
	}

	function showPanel(name: PanelName) {
		const current = latest.current.tabs;
		change({ tabs: current.includes(name) ? current : [...current, name], active: name, open: true });
	}

	useEffect(() => {
		if (panelRequest) showPanel(panelRequest);
	}, [panelRequest]);

	// When the agent hands work to its browser subagent, show the Browser panel so its work can be watched.
	const browsing = handingToBrowser(agent.messages[agent.messages.length - 1]);
	useEffect(() => {
		if (browsing) showPanel('Browser');
	}, [browsing]);

	const centerVisible = !(open && expanded);
	const send = useCallback((text: string) => agent.sendMessage(text), [agent.sendMessage]);

	return (
		<SendToAgent.Provider value={send}>
			<ShowPanel.Provider value={showPanel}>
				<div className="@container/workspace flex min-h-0 min-w-0 flex-1">
					{/* Hidden rather than unmounted while the workspace is expanded, so the conversation keeps its draft, scroll and stream. */}
					<div className={cn('min-h-0 min-w-0 flex-1 flex-col', !centerVisible ? 'hidden' : open ? 'hidden @min-[700px]/workspace:flex' : 'flex')}>
						<header className="flex h-11 shrink-0 items-center gap-2 pr-3 pl-2 md:pl-4">
							<MenuButton />
							{leading}
							{/* The state is a dot; it says Working or what went wrong in words, as finished is the usual state. Spend and tokens are in the composer's meter and the task menu. */}
							{status ? (
								<span className={`flex shrink-0 items-center gap-1.5 text-[12px] whitespace-nowrap ${status.text}`} title={status.label}>
									<span className={cn('size-1.5 shrink-0 rounded-full', status.dot, status.label === 'Working' && 'in-pulse')} />
									<span className={status.label === 'Finished' ? 'sr-only' : 'hidden sm:inline'}>{status.label}</span>
								</span>
							) : null}
							<TaskTitle session={session.data} editing={renaming} onEditingChange={setRenaming} />
							{session.data ? <PullRequestChip session={session.data} /> : null}
							{/* The workspace has its own Changes tab, so Review only shows while it is closed. */}
							{!open ? (
								<Btn variant="ghost" size="sm" icon={FileDiff} aria-label="Review" className="shrink-0" onClick={() => showPanel('Changes')}>
									<span className="hidden sm:inline">Review</span>
								</Btn>
							) : null}
							{session.data ? (
								<TaskMenu
									session={session.data}
									onRename={() => setRenaming(true)}
									onAskForPullRequest={() => void agent.sendMessage(pullRequestAsk(session.data))}
								/>
							) : null}
							{!open ? <IconBtn icon={PanelRight} size="sm" label="Show workspace" onClick={() => setOpen(true)} /> : null}
						</header>
						<Thread sessionId={sessionId} agent={agent} />
					</div>
					{open ? (
						<VmPanel
							sessionId={sessionId}
							tabs={tabs}
							active={active}
							onTabsChange={(next) => change({ tabs: next })}
							onActiveChange={(next) => change({ active: next })}
							expanded={expanded}
							onToggleExpanded={() => setExpanded((current) => !current)}
							onClose={() => setOpen(false)}
						/>
					) : null}
				</div>
			</ShowPanel.Provider>
		</SendToAgent.Provider>
	);
}

export function SessionPage() {
	const { sessionId } = useParams({ from: '/agents/$sessionId' });
	const search = useSearch({ from: '/agents/$sessionId' });
	const navigate = useNavigate();
	const [panels, setPanels] = useState<Omit<TaskPanels, 'open'>>(DEFAULT_PANELS);
	const open = search.app !== 'closed';
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
	// A project's thread opens inside its project, beside the coordinator and its other threads.
	const spaceId = session.data?.spaceId;
	useEffect(() => {
		if (spaceId) void navigate({ to: '/projects/$spaceId/threads/$threadId', params: { spaceId, threadId: sessionId }, search: { panel: search.panel }, replace: true });
	}, [spaceId]);
	return (
		<TaskWorkspace
			sessionId={sessionId}
			panels={{ ...panels, open }}
			onPanelsChange={(next) => {
				setPanels({ tabs: next.tabs, active: next.active });
				// Opening a panel drops it from the address, so asking again opens it again.
				if (next.open !== open || search.panel) void navigate({ to: '/agents/$sessionId', params: { sessionId }, search: { app: next.open ? 'code' : 'closed' } });
			}}
			panelRequest={search.panel}
		/>
	);
}
