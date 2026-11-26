import { type UseFlueAgentResult, useFlueAgent } from '@flue/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Check, ChevronRight, FileDiff, GitBranch, PanelRight } from '@/lib/icons';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReadNotificationsOf } from '@/components/shell/notifications';
import { MenuButton } from '@/components/kit/nav';
import { Badge, DiffStat, Icon, IconBtn } from '@/components/kit/signal';
import { useChanges } from '@/lib/changes';
import { PullRequestChip, TaskMenu, TaskTitle } from '@/components/shell/task-actions';
import { Thread } from '@/components/thread/thread';
import { VmPanel } from '@/components/workspace/vm-panel';
import { type PanelName, panels } from '@/components/workspace/panels';
import { PaneSlideContext, usePaneSlide } from '@/components/workspace/workspace-pane';
import { isChat, type Session } from '@/lib/api/sessions';
import { readPinnedPanels } from '@/lib/pinned-panels';
import { useOnePane } from '@/lib/one-pane';
import { SendToAgent } from '@/lib/review';
import { ShowPanel } from '@/lib/workspace';
import { readTaskAgain, showWorking, taskStatus, useFollowOnceStarted } from '@/lib/working';
import { afterStop, clearStopped, useStopped } from '@/lib/stopped';
import { useStarting } from '@/lib/starting';
import { StartingTask } from '@/components/thread/starting-task';
import { cn } from '@/lib/utils';
import { taskQueries } from '@/lib/task-queries';
import { useViewer } from '@/lib/viewer';
import { useOlderTurns, useWindowedClient, type WindowedAgent } from '@/lib/conversation-window';

/** The agent opens and updates pull requests itself, through its open_pull_request tool. */
function pullRequestAsk(session: Session): string {
	return session.prUrl
		? 'Commit and push the latest changes to the pull request.'
		: 'Open a pull request with the changes on this branch. Write a clear title and a short description.';
}

type StatusTone = { label: string; tone: 'accent' | 'danger' | 'success' };

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
const WORKING: StatusTone = { label: 'Working', tone: 'accent' };
const STOPPED: StatusTone = { label: 'Stopped', tone: 'danger' };
const FAILED: StatusTone = { label: 'Failed', tone: 'danger' };
const FINISHED: StatusTone = { label: 'Finished', tone: 'success' };

function statusFor(agent: UseFlueAgentResult): StatusTone | null {
	if (agent.status === 'submitted' || agent.status === 'streaming') return WORKING;
	const settled = agent.settlements[agent.settlements.length - 1];
	if (agent.status === 'error' || (settled && settled.outcome !== 'completed')) return settled?.outcome === 'aborted' ? STOPPED : FAILED;
	if (agent.messages.length > 0) return FINISHED;
	return null;
}

/** Current unpushed work, available even when the workspace is closed. */
export function HeaderChanges({ sessionId, onShowPanel }: { sessionId: string; onShowPanel: (name: PanelName) => void }) {
	const { files } = useChanges(sessionId);
	if (!files.length) return null;
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	return <button type="button" onClick={() => onShowPanel('Changes')} aria-label={`Open Changes: ${files.length} ${files.length === 1 ? 'file' : 'files'}, ${added} additions, ${removed} deletions`} className="inline-flex shrink-0 items-center gap-1.5 rounded-control px-2 py-1 text-micro text-(--text-2) hover:bg-(--bg-hover) outline-none focus-visible:shadow-(--focus)">
		<Icon icon={FileDiff} size={13} /><span className="in-num whitespace-nowrap">{files.length} {files.length === 1 ? 'file' : 'files'}</span><span className="in-num hidden sm:inline"><DiffStat added={added} removed={removed} /></span>
	</button>;
}

function BranchPill({ branch }: { branch: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<button
			type="button"
			title={copied ? 'Copied' : 'Copy the branch name'}
			aria-label={`Branch ${branch}: copy its name`}
			onClick={() => void navigator.clipboard.writeText(branch).then(() => setCopied(true), () => undefined)}
			className="hidden h-6 max-w-[220px] min-w-0 shrink items-center gap-1.5 rounded-control px-1.5 text-small font-medium text-(--text-2) outline-none transition-colors duration-(--t-fast) hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus) xl:inline-flex"
		>
			<Icon icon={copied ? Check : GitBranch} size={13} className="shrink-0 text-(--text-3)" />
			<span className="truncate font-mono text-micro">{branch}</span>
		</button>
	);
}

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
		<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-3 pl-2 md:pl-4">
			<MenuButton />
			{leading}
			{!leading && session?.repo ? (
				<span className="hidden min-w-0 shrink-[2] items-center gap-1.5 text-body text-(--text-3) md:flex">
					<span className="truncate">{session.repo.split('/').pop()}</span>
					<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--text-4)" />
				</span>
			) : null}
			<TaskTitle session={session} editing={renaming} onEditingChange={onRenamingChange} />
			{/* The state says Working or what went wrong in words, as finished is the usual state. Spend and tokens are in the composer's meter and the task menu. */}
			{status ? (
				status.label === 'Finished' ? (
					<span className="sr-only">{status.label}</span>
				) : (
					<span title={status.label} className="inline-flex shrink-0">
						<Badge tone={status.tone}>
							<span className={cn('size-[5px] shrink-0 rounded-full bg-current', status.label === 'Working' && 'in-pulse')} />
							<span className="hidden sm:inline">{status.label}</span>
						</Badge>
					</span>
				)
			) : null}
			<span className="min-w-0 flex-1" />
			{session && !isChat(session) && session.workspace && session.branch ? <BranchPill branch={session.branch} /> : null}
			{session ? <PullRequestChip session={session} /> : null}
			{session && !isChat(session) ? <HeaderChanges sessionId={session.id} onShowPanel={onShowPanel} /> : null}
			{session ? <TaskMenu session={session} onRename={() => onRenamingChange(true)} onAskForPullRequest={onAskForPullRequest} /> : null}
			{!workspaceOpen ? <IconBtn icon={PanelRight} size="sm" label="Show workspace" onClick={onOpenWorkspace} /> : null}
		</header>
	);
});

export type TaskPanels = { tabs: PanelName[]; active: PanelName | null; open: boolean };

export function startingPanels(): TaskPanels {
	const pinned = readPinnedPanels();
	const tabs = panels.map((panel) => panel.name).filter((name) => pinned.includes(name));
	return { tabs, active: tabs[0] ?? null, open: true };
}

/** Keeps one identity, so the memoized panels skip the stream's renders. Each change builds on the one before it, not on the last render: closing a tab changes the tabs and then the shown one in one click. */
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

function useTaskAgent(sessionId: string): WindowedAgent {
	const queryClient = useQueryClient();
	const path = `/api/agents/coder/${sessionId}`;
	const client = useWindowedClient(path);
	const agent = useOlderTurns(path, client, useFlueAgent({ client }));
	const session = useQuery(taskQueries.session(sessionId));
	const working = session.data?.working ?? false;
	useFollowOnceStarted(agent, session.dataUpdatedAt);
	// A stop made on this page shows at once in the header and the composer, until a later reply starts.
	const stopped = useStopped(sessionId);
	const status = afterStop(taskStatus(agent.status, working), stopped);
	const flueSend = agent.sendMessage;
	const sendMessage = useCallback<UseFlueAgentResult['sendMessage']>(
		async (...args) => {
			clearStopped(queryClient, sessionId);
			void showWorking(queryClient, sessionId);
			try {
				await flueSend(...args);
			} catch (error) {
				readTaskAgain(queryClient, sessionId);
				throw error;
			}
			// The server counts it working from here, so a fresh read agrees, and brings back what a dropped read carried.
			readTaskAgain(queryClient, sessionId);
		},
		[flueSend, queryClient, sessionId],
	);
	return useMemo(() => ({ ...agent, status, sendMessage }), [agent, status, sendMessage]);
}

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
	leading?: ReactNode;
}) {
	const [expanded, setExpanded] = useState(false);
	const [closingExpanded, setClosingExpanded] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const session = useQuery(taskQueries.session(sessionId));
	const agent = useTaskAgent(sessionId);
	const status = statusFor(agent);
	const { tabs, active } = panels;
	const change = usePanelChange(panels, onPanelsChange);
	// On a phone the workspace covers the conversation, so it shows only once you open it here; the saved choice is the wide screen's.
	const onePane = useOnePane();
	const [paneOpen, setPaneOpen] = useState(false);
	const viewer = useViewer();
	const workspaceOpen = onePane ? paneOpen : panels.open;
	const open = workspaceOpen || (!onePane && Boolean(viewer));

	const setOpen = useCallback(
		(next: boolean) => {
			if (!next && expanded) setClosingExpanded(true);
			if (next) setClosingExpanded(false);
			if (!next) setExpanded(false);
			if (onePane) setPaneOpen(next);
			else change({ open: next });
		},
		[change, expanded, onePane],
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

	const [covered, setCovered] = useState(expanded);
	useEffect(() => {
		if (!expanded) {
			setCovered(false);
			return;
		}
		const timer = setTimeout(() => setCovered(true), 300);
		return () => clearTimeout(timer);
	}, [expanded]);
	const centerVisible = !(open && covered);
	const slide = usePaneSlide(open);
	const send = useCallback((text: string) => agent.sendMessage(text), [agent.sendMessage]);
	const sessionData = session.data;
	const askForPullRequest = useCallback(() => {
		if (sessionData) void agent.sendMessage(pullRequestAsk(sessionData));
	}, [agent.sendMessage, sessionData]);

	return (
		<SendToAgent.Provider value={send}>
			<ShowPanel.Provider value={showPanel}>
				<ReadNotificationsOf sessionId={sessionId} />
				<div className="@container/workspace relative flex min-h-0 min-w-0 flex-1">
					{/* Hidden rather than unmounted while the workspace is expanded, so the conversation keeps its draft, scroll and stream. */}
					<div className={cn('min-h-0 min-w-0 flex-1 flex-col', !centerVisible ? 'hidden @min-[700px]/workspace:invisible @min-[700px]/workspace:flex' : open ? 'hidden @min-[700px]/workspace:flex' : 'flex')}>
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
					{slide ? (
						<PaneSlideContext.Provider value={slide}>
							<VmPanel
								sessionId={sessionId}
								contentOpen={workspaceOpen}
								tabs={tabs}
								active={active}
								onTabsChange={changeTabs}
								onActiveChange={changeActive}
								expanded={expanded}
								closingExpanded={closingExpanded}
								onToggleExpanded={toggleExpanded}
								onClose={closeWorkspace}
							/>
						</PaneSlideContext.Provider>
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
	const starting = useStarting(sessionId);
	const session = useQuery({ ...taskQueries.session(sessionId), enabled: !starting });
	const spaceId = session.data?.spaceId;
	useEffect(() => {
		if (spaceId) void navigate({ to: '/projects/$spaceId/threads/$threadId', params: { spaceId, threadId: sessionId }, search: { panel: search.panel }, replace: true });
	}, [spaceId]);
	if (starting) return <StartingTask starting={starting} workspace={open} narrow={panels.active === null} onDiscard={() => void navigate({ to: '/' })} />;
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
