import { ArrowUpRight, Check, ChevronRight, PanelRight, Plus, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { FilesTab } from '@/components/files-tab';
import { GitTab, useChanges } from '@/components/git-tab';
import { LibraryTab } from '@/components/library-tab';
import { PreviewTab } from '@/components/preview-tab';
import { Icon, IconBtn, Menu, MenuContent, MenuLabel, MenuTrigger } from '@/components/signal';
import { TerminalTab } from '@/components/terminal-tab';
import { cn } from '@/lib/utils';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';

export const panels = [
	{ name: 'Changes', desc: 'Every file the agent edited, as a diff' },
	{ name: 'Terminal', desc: 'The sandbox shell and its command output' },
	{ name: 'Files', desc: 'Browse the repository on the task branch' },
	{ name: 'Preview', desc: 'The app the agent is running, live from the sandbox' },
	{ name: 'Library', desc: 'Reports, screenshots and exports the agent saved' },
] as const;

export type PanelName = (typeof panels)[number]['name'];

const VIEWS: Record<PanelName, (props: { sessionId: string }) => ReactNode> = {
	Changes: GitTab,
	Terminal: TerminalTab,
	Files: FilesTab,
	Preview: PreviewTab,
	Library: LibraryTab,
};

function PanelTab({
	name,
	count,
	active,
	onSelect,
	onClose,
}: {
	name: PanelName;
	count?: number;
	active: boolean;
	onSelect: () => void;
	onClose: () => void;
}) {
	return (
		<div className="group relative flex h-7 shrink-0 items-center rounded-lg hover:bg-(--bg-hover)">
			{active ? <div className="absolute inset-0 rounded-lg bg-(--bg-overlay)" /> : null}
			<button
				type="button"
				role="tab"
				aria-selected={active}
				onClick={onSelect}
				className="relative flex h-full items-center gap-1.5 rounded-lg pl-2.5 outline-none focus-visible:shadow-(--focus-ring)"
			>
				<span className="text-[12px] whitespace-nowrap text-(--text-secondary)">{name}</span>
				{count ? <span className="text-[11px] text-(--text-tertiary)">{count}</span> : null}
			</button>
			<span className="relative mr-1.5 ml-1.5 inline-flex size-4 shrink-0 items-center justify-center">
				<button
					type="button"
					aria-label={`Close ${name}`}
					onClick={onClose}
					className="hidden size-4 items-center justify-center rounded-sm bg-(--alpha-white-9) text-(--text-secondary) group-focus-within:inline-flex group-hover:inline-flex hover:bg-(--alpha-white-14) hover:text-(--text-primary)"
				>
					<Icon icon={X} size={10} />
				</button>
			</span>
		</div>
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
		<section className="flex min-w-0 flex-[1_1_46%] flex-col overflow-hidden border-(--border-subtle) md:min-w-[280px] md:border-l">
			<div className="flex h-11 min-w-0 shrink-0 items-center gap-2 px-2">
				<div data-noscrollbar role="tablist" className="flex min-w-0 flex-auto items-center gap-0.5 overflow-x-auto overflow-y-hidden">
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
									className="flex items-start gap-2 rounded-md px-2 py-1.5 outline-none data-highlighted:bg-(--bg-hover)"
								>
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
						icon={expanded ? ChevronRight : ArrowUpRight}
						size="sm"
						label={expanded ? 'Restore the conversation' : 'Expand workspace'}
						onClick={onToggleExpanded}
						className="hidden md:inline-flex"
					/>
					<IconBtn icon={PanelRight} size="sm" label="Hide workspace" onClick={onClose} />
				</div>
			</div>

			<div className={cn('min-h-0 flex-1', current === 'Terminal' || current === 'Preview' ? 'flex flex-col px-3 pb-3' : 'overflow-y-auto px-3 pb-3')}>
				{current === null ? (
					<div className="flex min-h-full items-center justify-center px-2 py-6">
						<div className="flex w-full max-w-80 flex-col gap-0.5">
							{panels.map((panel) => (
								<button
									type="button"
									key={panel.name}
									onClick={() => show(panel.name)}
									className="flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
								>
									<div className="text-[13px] text-(--text-primary)">{panel.name}</div>
									<div className="text-[12px] text-pretty text-(--text-tertiary)">{panel.desc}</div>
								</button>
							))}
						</div>
					</div>
				) : null}
				{View ? <View sessionId={sessionId} /> : null}
			</div>
		</section>
	);
}
