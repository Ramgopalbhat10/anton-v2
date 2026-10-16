import { type UseFlueAgentResult, useFlueAgent } from '@flue/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { FileDiff, PanelRight } from 'lucide-react';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatSidebar, SidebarRail } from '@/components/chat-sidebar';
import { CommandPalette } from '@/components/command-palette';
import { Launcher } from '@/components/launcher';
import { MenuButton, NavContext } from '@/components/nav';
import { Btn, IconBtn } from '@/components/signal';
import { PullRequestChip, TaskMenu, TaskTitle } from '@/components/task-actions';
import { Thread } from '@/components/thread';
import { type PanelName, panels, VmPanel } from '@/components/vm-panel';
import { api, isChat, type Session } from '@/lib/api';
import { readPinnedPanels } from '@/lib/pinned-panels';
import { useLiveUpdates } from '@/lib/live-updates';
import { useOnePane } from '@/lib/one-pane';
import { useTaskNotifications } from '@/lib/notifications';
import { serviceWorker, turnOnIfAllowed, useOpenFromNotifications, usePresence } from '@/lib/push';
import { SendToAgent } from '@/lib/review';
import { ShowPanel } from '@/lib/workspace';
import { forgetWorking, showWorking, taskStatus } from '@/lib/working';
import { cn } from '@/lib/utils';

function readCollapsed() {
	try {
		return localStorage.getItem('anton.sidebar') === 'collapsed';
	} catch {
		return false;
	}
}

/**
 * Watches the task list for notifications on its own, so a change to the list does not re-render the whole shell.
 * Also starts the service worker that shows pushed notifications, opens their tasks when tapped, and tells the
 * server while this page is in front of you, so your phone stays quiet then.
 */
function TaskNotifications() {
	useTaskNotifications();
	useOpenFromNotifications();
	usePresence();
	useEffect(() => {
		void serviceWorker().then(() => turnOnIfAllowed());
	}, []);
	return null;
}

export function AppShell() {
	const [navOpen, setNavOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const closePalette = useCallback(() => setPaletteOpen(false), []);
	const closeNav = useCallback(() => setNavOpen(false), []);
	const collapse = useCallback(() => setCollapsed(true), []);
	const openPalette = useCallback(() => {
		setNavOpen(false);
		setPaletteOpen(true);
	}, []);
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
			{/* Padded by the safe-area insets, so on a phone the app clears its notch and home bar. */}
			<div className="flex h-dvh overflow-hidden bg-(--bg-canvas) pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-[13px] leading-[18px] text-(--text-primary)">
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
						onNavigate={closeNav}
						onCollapse={collapse}
						onOpenPalette={openPalette}
					/>
				</div>
				<main className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--bg-canvas)">
					<Outlet />
				</main>
				<CommandPalette open={paletteOpen} onClose={closePalette} />
				<TaskNotifications />
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

/** The panel to show when the agent hands work to its browser or computer subagent, so its work can be watched. */
function handingTo(message: UseFlueAgentResult['messages'][number] | undefined): 'Browser' | 'Computer' | null {
	for (const part of message?.parts ?? []) {
		if (part.type !== 'dynamic-tool' || part.toolName !== 'task' || part.state !== 'input-available') continue;
		const agent = (part.input as { agent?: unknown } | undefined)?.agent;
		if (agent === 'browser') return 'Browser';
		if (agent === 'computer') return 'Computer';
	}
	return null;
}

// One object per state, so the header sees the same status from chunk to chunk.
const WORKING: StatusTone = { label: 'Working', text: 'text-(--accent-text)', dot: 'bg-(--accent-base)' };
const STOPPED: StatusTone = { label: 'Stopped', text: 'text-(--danger-text)', dot: 'bg-(--danger-base)' };
const FAILED: StatusTone = { label: 'Failed', text: 'text-(--danger-text)', dot: 'bg-(--danger-base)' };
const FINISHED: StatusTone = { label: 'Finished', text: 'text-(--success-text)', dot: 'bg-(--success-base)' };

function statusFor(agent: UseFlueAgentResult): StatusTone | null {
	if (agent.status === 'submitted' || agent.status === 'streaming') return WORKING;
	const settled = agent.settlements[agent.settlements.length - 1];
	if (agent.status === 'error' || (settled && settled.outcome !== 'completed')) return settled?.outcome === 'aborted' ? STOPPED : FAILED;
	if (agent.messages.length > 0) return FINISHED;
	return null;
}

/**
 * The task's header: its state, title, pull request and menu. Memoized, as
 * the workspace around it re-renders with every streamed chunk.
 */
const TaskHeader = memo(function TaskHeader({
	session,
	status,
	leading,
	workspaceOpen,
	renaming,
	onRenamingChange,
	onShowPanel,
	onOpenWorkspace,
	onAskForPullRequest,
}: {
	session: Session | undefined;
	status: StatusTone | null;
	leading?: ReactNode;
	workspaceOpen: boolean;
	renaming: boolean;
	onRenamingChange: (renaming: boolean) => void;
	onShowPanel: (name: PanelName) => void;
	onOpenWorkspace: () => void;
	onAskForPullRequest: () => void;
}) {
	return (
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
			<TaskTitle session={session} editing={renaming} onEditingChange={onRenamingChange} />
			{session ? <PullRequestChip session={session} /> : null}
			{/* The workspace has its own Changes tab, so Review only shows while it is closed; a chat has no code to review. */}
			{!workspaceOpen && session && !isChat(session) ? (
				<Btn variant="ghost" size="sm" icon={FileDiff} aria-label="Review" className="shrink-0" onClick={() => onShowPanel('Changes')}>
					<span className="hidden sm:inline">Review</span>
				</Btn>
			) : null}
			{session ? <TaskMenu session={session} onRename={() => onRenamingChange(true)} onAskForPullRequest={onAskForPullRequest} /> : null}
			{!workspaceOpen ? <IconBtn icon={PanelRight} size="sm" label="Show workspace" onClick={onOpenWorkspace} /> : null}
		</header>
	);
});

/** Which workspace panels a task has open, which one shows, and whether the workspace is open at all. */
export type TaskPanels = { tabs: PanelName[]; active: PanelName | null; open: boolean };

/** A task or thread opens with the panels you pinned, in the menu's order with the first one shown; with none pinned, on the list of panels to open. */
export function startingPanels(): TaskPanels {
	const pinned = readPinnedPanels();
	const tabs = panels.map((panel) => panel.name).filter((name) => pinned.includes(name));
	return { tabs, active: tabs[0] ?? null, open: true };
}

/**
 * A change to the workspace's panels that keeps one identity, so the memoized
 * panels skip the stream's renders. Each change builds on the one before it,
 * not on the last render: closing a tab changes the tabs and then which one is
 * shown, in one click, and the second must not bring back the first's tabs.
 */
export function usePanelChange(
	panels: TaskPanels,
	onPanelsChange: (next: TaskPanels) => void,
): (next: Partial<TaskPanels> | ((current: TaskPanels) => Partial<TaskPanels>)) => void {
	const latest = useRef(panels);
	latest.current = panels;
	const report = useRef(onPanelsChange);
	report.current = onPanelsChange;
	return useCallback((next: Partial<TaskPanels> | ((current: TaskPanels) => Partial<TaskPanels>)) => {
		latest.current = { ...latest.current, ...(typeof next === 'function' ? next(latest.current) : next) };
		report.current(latest.current);
	}, []);
}

/** The task's coding agent; sending it a message shows the task working at once, everywhere it is listed, and a reply started anywhere shows as working. */
function useTaskAgent(sessionId: string): UseFlueAgentResult {
	const queryClient = useQueryClient();
	const agent = useFlueAgent({ url: `/api/agents/coder/${sessionId}` });
	const working = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) }).data?.working ?? false;
	const status = taskStatus(agent.status, working);
	const flueSend = agent.sendMessage;
	const sendMessage = useCallback<UseFlueAgentResult['sendMessage']>(
		async (...args) => {
			void showWorking(queryClient, sessionId);
			try {
				await flueSend(...args);
			} catch (error) {
				forgetWorking(queryClient, sessionId);
				throw error;
			}
		},
		[flueSend, queryClient, sessionId],
	);
	return useMemo(() => ({ ...agent, status, sendMessage }), [agent, status, sendMessage]);
}

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
	const agent = useTaskAgent(sessionId);
	const status = statusFor(agent);
	const { tabs, active } = panels;
	const change = usePanelChange(panels, onPanelsChange);
	// On a phone the workspace covers the conversation, so it shows only once you open it here; the saved choice is the wide screen's.
	const onePane = useOnePane();
	const [paneOpen, setPaneOpen] = useState(false);
	const open = onePane ? paneOpen : panels.open;

	const setOpen = useCallback(
		(next: boolean) => {
			if (!next) setExpanded(false);
			if (onePane) setPaneOpen(next);
			else change({ open: next });
		},
		[change, onePane],
	);

	/** Opens a panel; `quietly` only picks it, without covering the conversation on a phone. */
	const showPanel = useCallback(
		(name: PanelName, quietly = false) => {
			if (onePane && !quietly) setPaneOpen(true);
			change(({ tabs }) => ({ tabs: tabs.includes(name) ? tabs : [...tabs, name], active: name, ...(onePane ? {} : { open: true }) }));
		},
		[change, onePane],
	);
	const openWorkspace = useCallback(() => setOpen(true), [setOpen]);
	const closeWorkspace = useCallback(() => setOpen(false), [setOpen]);
	const changeTabs = useCallback((next: PanelName[]) => change({ tabs: next }), [change]);
	const changeActive = useCallback((next: PanelName | null) => change({ active: next }), [change]);
	const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

	useEffect(() => {
		if (panelRequest) showPanel(panelRequest);
	}, [panelRequest]);

	// When the agent hands work to its browser or computer subagent, show that panel so its work can be watched.
	// On a phone it is only picked, so the conversation you are reading stays in view.
	const watching = handingTo(agent.messages[agent.messages.length - 1]);
	useEffect(() => {
		if (watching) showPanel(watching, true);
	}, [watching]);

	const centerVisible = !(open && expanded);
	const send = useCallback((text: string) => agent.sendMessage(text), [agent.sendMessage]);
	const sessionData = session.data;
	const askForPullRequest = useCallback(() => {
		if (sessionData) void agent.sendMessage(pullRequestAsk(sessionData));
	}, [agent.sendMessage, sessionData]);

	return (
		<SendToAgent.Provider value={send}>
			<ShowPanel.Provider value={showPanel}>
				<div className="@container/workspace flex min-h-0 min-w-0 flex-1">
					{/* Hidden rather than unmounted while the workspace is expanded, so the conversation keeps its draft, scroll and stream. */}
					<div className={cn('min-h-0 min-w-0 flex-1 flex-col', !centerVisible ? 'hidden' : open ? 'hidden @min-[700px]/workspace:flex' : 'flex')}>
						<TaskHeader
							session={sessionData}
							status={status}
							leading={leading}
							workspaceOpen={open}
							renaming={renaming}
							onRenamingChange={setRenaming}
							onShowPanel={showPanel}
							onOpenWorkspace={openWorkspace}
							onAskForPullRequest={askForPullRequest}
						/>
						<Thread sessionId={sessionId} agent={agent} />
					</div>
					{open ? (
						<VmPanel
							sessionId={sessionId}
							tabs={tabs}
							active={active}
							onTabsChange={changeTabs}
							onActiveChange={changeActive}
							expanded={expanded}
							onToggleExpanded={toggleExpanded}
							onClose={closeWorkspace}
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
	const [panels, setPanels] = useState<Omit<TaskPanels, 'open'>>(startingPanels);
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
