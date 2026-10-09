import { useQuery } from '@tanstack/react-query';
import { AppWindow, Check, FileDiff, Files, Globe, History, Library, Loader, Maximize2, Minimize2, PanelRight, Play, Plus, SquareTerminal, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { WorkspacePane } from '@/components/workspace-pane';
import { BrowserTab } from '@/components/browser-tab';
import { FilesTab } from '@/components/files-tab';
import { HistoryTab } from '@/components/history-tab';
import { GitTab, useChanges } from '@/components/git-tab';
import { LibraryTab } from '@/components/library-tab';
import { PreviewTab } from '@/components/preview-tab';
import { useResume } from '@/components/source-bar';
import { Icon, IconBtn, Menu, MenuContent, MenuLabel, MenuTrigger } from '@/components/signal';
import { TerminalTab } from '@/components/terminal-tab';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';

export const panels = [
	{ name: 'Changes', icon: FileDiff, desc: 'Every file the agent edited, as a diff' },
	{ name: 'Terminal', icon: SquareTerminal, desc: 'The sandbox shell and its command output' },
	{ name: 'Files', icon: Files, desc: 'Browse the repository on the task branch' },
	{ name: 'Preview', icon: Globe, desc: 'The app the agent is running, live from the sandbox' },
	{ name: 'Browser', icon: AppWindow, desc: 'A real browser for any site; pick elements or draw for the agent' },
	{ name: 'Library', icon: Library, desc: 'Reports, screenshots and exports the agent saved' },
	{ name: 'History', icon: History, desc: 'Earlier states of the files, to compare or restore' },
] as const;

export type PanelName = (typeof panels)[number]['name'];

const VIEWS: Record<PanelName, (props: { sessionId: string }) => ReactNode> = {
	Changes: GitTab,
	Terminal: TerminalTab,
	Files: FilesTab,
	Preview: PreviewTab,
	Browser: BrowserTab,
	Library: LibraryTab,
	History: HistoryTab,
};

/**
 * One open panel as a button, raised when it is the one shown. Hovering it
 * swaps its icon for the close button, in the same place.
 */
function PanelTab({ name, count, active, onSelect, onClose }: { name: PanelName; count?: number; active: boolean; onSelect: () => void; onClose: () => void }) {
	const panel = panels.find((panel) => panel.name === name)!;
	return (
		<div className="group/tab relative flex h-7 shrink-0 items-center rounded-[8px] hover:bg-(--bg-hover)">
			{active ? <div className="absolute inset-0 rounded-[8px] border border-(--card-border) bg-[linear-gradient(180deg,var(--neutral-750),var(--neutral-800))] shadow-(--card-highlight)" /> : null}
			<button
				type="button"
				role="tab"
				aria-selected={active}
				onClick={onSelect}
				className="relative flex h-full items-center gap-1.5 rounded-[8px] pr-2 pl-1.5 outline-none focus-visible:shadow-(--focus-ring)"
			>
				<span
					className={cn(
						'inline-flex size-4 shrink-0 items-center justify-center transition-opacity duration-(--duration-micro) group-focus-within/tab:opacity-0 group-hover/tab:opacity-0',
						active ? 'text-(--accent-text)' : 'text-(--icon-tertiary)',
					)}
				>
					<Icon icon={panel.icon} size={12} />
				</span>
				<span className={cn('text-[12px] whitespace-nowrap', active ? 'text-(--text-primary)' : 'text-(--text-secondary)')}>{name}</span>
				{count ? (
					<span className="in-num inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-(--accent-bg-subtle) px-1 text-[10px] text-(--accent-text)">{count}</span>
				) : null}
			</button>
			<button
				type="button"
				aria-label={`Close ${name}`}
				onClick={onClose}
				className="absolute top-1/2 left-1.5 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-(--text-secondary) opacity-0 transition-opacity duration-(--duration-micro) outline-none group-focus-within/tab:opacity-100 group-hover/tab:opacity-100 hover:bg-(--alpha-white-14) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
			>
				<Icon icon={X} size={12} />
			</button>
		</div>
	);
}

/**
 * Starts the task's sandbox from where it stopped, shown while it is not
 * running. Until then the panels show the task's files as they were last
 * saved, or as the branch was when the task began.
 */
function ResumeButton({ sessionId }: { sessionId: string }) {
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
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

export function VmPanel({
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
		<WorkspacePane expanded={expanded}>
			<div className="flex h-11 min-w-0 shrink-0 items-center gap-2 px-2">
				<div data-noscrollbar role="tablist" aria-label="Workspace panels" className="flex min-w-0 flex-auto items-center gap-0.5 overflow-x-auto overflow-y-hidden">
					{tabs.map((name) => (
						<PanelTab
							key={name}
							name={name}
							count={name === 'Changes' ? changed : undefined}
							active={current === name}
							onSelect={() => onActiveChange(name)}
							onClose={() => close(name)}
						/>
					))}
				</div>
				<div className="relative flex shrink-0 items-center gap-0.5">
					<ResumeButton sessionId={sessionId} />
					<Menu open={menuOpen} onOpenChange={setMenuOpen}>
						<MenuTrigger asChild>
							<IconBtn icon={Plus} size="sm" label="Add a panel" />
						</MenuTrigger>
						<MenuContent align="end" className="w-[272px]">
							<MenuLabel>Add a panel</MenuLabel>
							{panels.map((panel) => (
								<MenuPrimitive.Item
									key={panel.name}
									onSelect={() => show(panel.name)}
									className="flex items-start gap-2.5 rounded-[8px] px-2 py-1.5 outline-none data-highlighted:bg-(--bg-hover)"
								>
									<span className="mt-px inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-(--border-subtle) bg-(--well-bg) text-(--icon-secondary)">
										<Icon icon={panel.icon} size={13} />
									</span>
									<div className="flex min-w-0 flex-1 flex-col gap-0.5">
										<div className="text-[13px] text-(--text-primary)">{panel.name}</div>
										<div className="text-[12px] text-pretty text-(--text-tertiary)">{panel.desc}</div>
									</div>
									{tabs.includes(panel.name) ? (
										<span className="inline-flex shrink-0 pt-0.5 text-(--accent-text)">
											<Icon icon={Check} size={12} />
										</span>
									) : null}
								</MenuPrimitive.Item>
							))}
						</MenuContent>
					</Menu>
					<IconBtn
						icon={expanded ? Minimize2 : Maximize2}
						size="sm"
						label={expanded ? 'Restore the conversation' : 'Expand workspace'}
						onClick={onToggleExpanded}
						className="hidden @min-[700px]/workspace:inline-flex"
					/>
					<IconBtn icon={PanelRight} size="sm" label="Hide workspace" onClick={onClose} />
				</div>
			</div>

			<div
				className={cn(
					'min-h-0 flex-1',
					current === 'Terminal' || current === 'Preview' || current === 'Browser' || current === 'Files' ? 'flex flex-col px-3 pb-3' : 'overflow-y-auto px-3 pb-3',
				)}
			>
				{current === null ? (
					<div className="flex min-h-full items-center justify-center px-2 py-6">
						<div className="flex w-full max-w-[520px] flex-col gap-3">
							<div className="in-caption px-1">Open a panel</div>
							<div className="grid gap-2 sm:grid-cols-2">
								{panels.map((panel) => (
									<button
										type="button"
										key={panel.name}
										onClick={() => show(panel.name)}
										className="in-card group/panel flex-row items-start gap-3 px-3 py-3 text-left outline-none hover:border-(--border-strong) focus-visible:shadow-(--focus-ring)"
									>
										<span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-dashed border-(--border-strong) text-(--icon-secondary) group-hover/panel:border-(--accent-border) group-hover/panel:text-(--accent-text)">
											<Icon icon={panel.icon} size={14} />
										</span>
										<span className="flex min-w-0 flex-col gap-0.5">
											<span className="text-[13px] font-medium text-(--text-primary)">{panel.name}</span>
											<span className="text-[12px] leading-[17px] text-pretty text-(--text-tertiary)">{panel.desc}</span>
										</span>
									</button>
								))}
							</div>
						</div>
					</div>
				) : null}
				{View ? <View key={sessionId} sessionId={sessionId} /> : null}
			</div>
		</WorkspacePane>
	);
}
