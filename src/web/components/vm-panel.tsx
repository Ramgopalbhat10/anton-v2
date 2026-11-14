import { useQuery } from '@tanstack/react-query';
import { AppWindow, ArrowLeft, Bot, Check, FileDiff, Files, GitPullRequest, Globe, History, Library, Loader, Maximize2, Minimize2, Monitor, PanelRight, Pin, Play, Plus, SquareTerminal } from 'lucide-react';
import { type ComponentType, lazy, memo, useState } from 'react';
import { WorkspacePane } from '@/components/workspace-pane';
import { LazyPart } from '@/components/error-boundary';
import { GitTab, useChanges } from '@/components/git-tab';
import { LibraryTab } from '@/components/library-tab';
import { useResume } from '@/components/source-bar';
import { Count, PanelTab, PanelTabs } from '@/components/instrument';
import { Icon, IconBtn, Menu, MenuContent, MenuLabel, MenuTrigger, SectionLabel } from '@/components/signal';
import { togglePinnedPanel, usePinnedPanels } from '@/lib/pinned-panels';
import { cn } from '@/lib/utils';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import { taskQueries } from '@/lib/task-queries';

export const panels = [
	{ name: 'Changes', icon: FileDiff, desc: 'What the agent changed that GitHub does not have yet, as a diff' },
	{ name: 'PR', icon: GitPullRequest, desc: "The thread's pull requests: checks, discussion, diff, and Merge" },
	{ name: 'Agents', icon: Bot, desc: 'The subagents the agent hands work to, live, step by step' },
	{ name: 'Terminal', icon: SquareTerminal, desc: 'The sandbox shell and its command output' },
	{ name: 'Files', icon: Files, desc: 'Browse the repository on the task branch' },
	{ name: 'Preview', icon: Globe, desc: 'The app the agent is running, live from the sandbox' },
	{ name: 'Browser', icon: AppWindow, desc: 'A real browser for any site; pick elements or draw for the agent' },
	{ name: 'Computer', icon: Monitor, desc: "Watch the agent test local apps on the sandbox's screen, or take over" },
	{ name: 'Library', icon: Library, desc: 'Reports, screenshots and exports the agent saved' },
	{ name: 'History', icon: History, desc: 'Earlier states of the files, to compare or restore' },
] as const;

export type PanelName = (typeof panels)[number]['name'];

/**
 * Each panel takes only the task's id and keeps itself current from its own
 * queries, so it is memoized: nothing the conversation beside it does, such
 * as streaming a reply, re-renders a file tree or a diff.
 *
 * Most panels load their code the first time one is opened, so a page that
 * never opens the terminal or the desktop never downloads xterm or noVNC.
 * Changes and Library are in the page already: the header and the file
 * viewer use their parts.
 */
const PrTab = lazy(() => import('@/components/pr-tab').then((module) => ({ default: module.PrTab })));
const AgentsTab = lazy(() => import('@/components/agents-tab').then((module) => ({ default: module.AgentsTab })));
const TerminalTab = lazy(() => import('@/components/terminal-tab').then((module) => ({ default: module.TerminalTab })));
const FilesTab = lazy(() => import('@/components/files-tab').then((module) => ({ default: module.FilesTab })));
const PreviewTab = lazy(() => import('@/components/preview-tab').then((module) => ({ default: module.PreviewTab })));
const BrowserTab = lazy(() => import('@/components/browser-tab').then((module) => ({ default: module.BrowserTab })));
const ComputerTab = lazy(() => import('@/components/computer-tab').then((module) => ({ default: module.ComputerTab })));
const HistoryTab = lazy(() => import('@/components/history-tab').then((module) => ({ default: module.HistoryTab })));

const VIEWS: Record<PanelName, ComponentType<{ sessionId: string }>> = {
	Changes: memo(GitTab),
	PR: memo(PrTab),
	Agents: memo(AgentsTab),
	Terminal: memo(TerminalTab),
	Files: memo(FilesTab),
	Preview: memo(PreviewTab),
	Browser: memo(BrowserTab),
	Computer: memo(ComputerTab),
	Library: memo(LibraryTab),
	History: memo(HistoryTab),
};

/**
 * Starts the task's sandbox from where it stopped, shown while it is not
 * running. Until then the panels show the task's files as they were last
 * saved, or as the branch was when the task began.
 */
function ResumeButton({ sessionId }: { sessionId: string }) {
	const session = useQuery(taskQueries.session(sessionId));
	const resume = useResume(sessionId);
	const status = session.data?.status;
	if (!session.data || status === 'running') return null;
	const starting = status === 'starting' || resume.isPending;
	const showing = session.data.checkpointAt ? 'the files as last saved' : 'the files as the branch was when the task began';
	return (
		<IconBtn
			icon={starting ? Loader : Play}
			size="sm"
			label={starting ? 'Starting the sandbox' : `Resume: start the sandbox. Until then these panels show ${showing}.`}
			disabled={starting}
			onClick={() => resume.mutate()}
			className={cn(starting && '[&_svg]:animate-spin')}
		/>
	);
}

export const VmPanel = memo(function VmPanel({
	sessionId,
	tabs,
	active,
	onTabsChange,
	onActiveChange,
	expanded,
	onToggleExpanded,
	onClose,
}: {
	sessionId: string;
	tabs: PanelName[];
	active: PanelName | null;
	onTabsChange: (tabs: PanelName[]) => void;
	onActiveChange: (tab: PanelName | null) => void;
	expanded: boolean;
	onToggleExpanded: () => void;
	onClose: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const changed = useChanges(sessionId).files.length;
	const pinned = usePinnedPanels();

	function show(name: PanelName) {
		if (!tabs.includes(name)) onTabsChange([...tabs, name]);
		onActiveChange(name);
	}

	function close(name: PanelName) {
		const next = tabs.filter((item) => item !== name);
		onTabsChange(next);
		if (active === name) {
			const index = tabs.indexOf(name);
			onActiveChange(next[Math.max(0, index - 1)] ?? null);
		}
	}

	const current = active && tabs.includes(active) ? active : null;
	const View = current ? VIEWS[current] : null;

	return (
		<WorkspacePane expanded={expanded} narrow={current === null && !expanded}>
			<div className="flex h-11 min-w-0 shrink-0 items-center gap-2 px-2">
				{/* On a phone the workspace covers the conversation; this goes back to it. */}
				<IconBtn icon={ArrowLeft} size="sm" label="Back to the conversation" onClick={onClose} className="shrink-0 @min-[700px]/workspace:hidden" />
				<PanelTabs label="Workspace panels">
					{tabs.map((name) => (
						<PanelTab
							key={name}
							on={current === name}
							mark={<Icon icon={panels.find((panel) => panel.name === name)!.icon} size={12} />}
							onSelect={() => onActiveChange(name)}
							onClose={() => close(name)}
							closeLabel={`Close ${name}`}
						>
							{name}
							{name === 'Changes' && changed ? <Count tone="accent">{changed}</Count> : null}
						</PanelTab>
					))}
				</PanelTabs>
				<div className="relative flex shrink-0 items-center gap-0.5">
					<ResumeButton sessionId={sessionId} />
					<Menu open={menuOpen} onOpenChange={setMenuOpen}>
						<MenuTrigger asChild>
							<IconBtn icon={Plus} size="sm" label="Add a panel" />
						</MenuTrigger>
						<MenuContent align="end" className="w-[224px]">
							<MenuLabel>Add a panel</MenuLabel>
							{panels.map((panel) => {
								const isPinned = pinned.includes(panel.name);
								return (
									<div key={panel.name} className="group/row flex items-center gap-0.5">
										<MenuPrimitive.Item
											onSelect={() => show(panel.name)}
											className="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-control px-2 outline-none data-highlighted:bg-(--bg-hover)"
										>
											<span className="inline-flex shrink-0 text-(--text-2)">
												<Icon icon={panel.icon} size={13} />
											</span>
											<span className="min-w-0 flex-1 truncate text-body text-(--text)">{panel.name}</span>
											{tabs.includes(panel.name) ? (
												<span className="inline-flex shrink-0 text-(--accent-text)">
													<Icon icon={Check} size={12} />
												</span>
											) : null}
										</MenuPrimitive.Item>
										{/* Its own item, so the keyboard reaches it; pinning keeps the menu open. */}
										<MenuPrimitive.Item
											aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${panel.name}`}
											aria-pressed={isPinned}
											onSelect={(event) => {
												event.preventDefault();
												togglePinnedPanel(panel.name);
											}}
											className={cn(
												'inline-flex size-8 shrink-0 items-center justify-center rounded-control outline-none data-highlighted:bg-(--bg-hover)',
												isPinned ? 'text-(--accent-text)' : 'text-(--text-3) opacity-40 group-hover/row:opacity-100 data-highlighted:opacity-100',
											)}
										>
											<Icon icon={Pin} size={12} className={cn(isPinned && '[&_path]:fill-current')} />
										</MenuPrimitive.Item>
									</div>
								);
							})}
							<div className="px-2 pt-1.5 pb-1 text-micro leading-[15px] text-(--text-3)">
								{pinned.length ? 'Tasks open with the pinned panels.' : 'Pin panels to open them with every task.'}
							</div>
						</MenuContent>
					</Menu>
					<IconBtn
						icon={expanded ? Minimize2 : Maximize2}
						size="sm"
						label={expanded ? 'Restore the conversation' : 'Expand workspace'}
						onClick={onToggleExpanded}
						className="hidden @min-[700px]/workspace:inline-flex"
					/>
					<IconBtn icon={PanelRight} size="sm" label="Hide workspace" onClick={onClose} className="hidden @min-[700px]/workspace:inline-flex" />
				</div>
			</div>

			<div
				className={cn(
					'min-h-0 flex-1',
					current === 'Terminal' || current === 'Preview' || current === 'Browser' || current === 'Files' || current === 'Changes' ? 'flex flex-col px-3 pb-3' : 'overflow-y-auto px-3 pb-3',
				)}
			>
				{current === null ? (
					<nav aria-label="Open a panel" className="flex flex-col gap-0.5 px-2 pt-1 pb-4">
						<SectionLabel className="px-2 pt-1 pb-1.5">Open a panel</SectionLabel>
						{panels.map((panel) => (
							<button
								type="button"
								key={panel.name}
								title={panel.desc}
								onClick={() => show(panel.name)}
								className="group/panel flex h-8 items-center gap-2.5 rounded-control px-2 text-left text-body text-(--text-2) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
							>
								<Icon icon={panel.icon} size={14} className="text-(--text-3) group-hover/panel:text-(--text-2)" />
								{panel.name}
							</button>
						))}
					</nav>
				) : null}
				{current ? (
					<LazyPart key={`${sessionId} ${current}`} label={`The ${current} panel`} className="m-3">
						{current === 'Preview' ? <PreviewTab sessionId={sessionId} onWatchTest={() => show('Computer')} /> : View ? <View sessionId={sessionId} /> : null}
					</LazyPart>
				) : null}
			</div>
		</WorkspacePane>
	);
});
