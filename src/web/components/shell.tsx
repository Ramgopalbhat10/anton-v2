import { type UseFlueAgentResult, useFlueAgent } from '@flue/react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { GitPullRequest, PanelRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ChatSidebar, SidebarRail } from '@/components/chat-sidebar';
import { CommandPalette } from '@/components/command-palette';
import { Launcher } from '@/components/launcher';
import { MenuButton, NavContext } from '@/components/nav';
import { Btn, IconBtn } from '@/components/signal';
import { Thread } from '@/components/thread';
import { type PanelName, VmPanel } from '@/components/vm-panel';
import { api } from '@/lib/api';

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

type StatusTone = { label: string; text: string; dot: string };

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

export function SessionPage() {
	const { sessionId } = useParams({ from: '/agents/$sessionId' });
	const search = useSearch({ from: '/agents/$sessionId' });
	const navigate = useNavigate();
	const open = search.app !== 'closed';
	const [expanded, setExpanded] = useState(false);
	const [tabs, setTabs] = useState<PanelName[]>(['Changes', 'Terminal', 'Files']);
	const [active, setActive] = useState<PanelName | null>('Changes');
	const session = useQuery({
		queryKey: ['session', sessionId],
		queryFn: () => api.session(sessionId),
	});
	const agent = useFlueAgent({ url: `/api/agents/coder/${sessionId}` });
	const status = statusFor(agent);

	function setOpen(next: boolean) {
		if (!next) setExpanded(false);
		void navigate({
			to: '/agents/$sessionId',
			params: { sessionId },
			search: { app: next ? 'code' : 'closed' },
		});
	}

	function showPanel(name: PanelName) {
		setTabs((current) => (current.includes(name) ? current : [...current, name]));
		setActive(name);
		setOpen(true);
	}

	const centerVisible = !(open && expanded);

	return (
		<div className="flex min-h-0 flex-1">
			{centerVisible ? (
				<div className={open ? 'hidden min-h-0 min-w-[340px] flex-[1_1_54%] flex-col md:flex' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>
					<header className="flex h-11 shrink-0 items-center gap-2 pr-3 pl-2 md:pl-4">
						<MenuButton />
						<div className="min-w-[100px] flex-auto truncate text-[13px] font-medium">
							{session.data?.title ?? 'Task'}
						</div>
						{status ? (
							<div className={`flex shrink-0 items-center gap-1.5 text-[12px] whitespace-nowrap ${status.text}`}>
								<span className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />
								{status.label}
							</div>
						) : null}
						<Btn variant="ghost" size="sm" icon={GitPullRequest} onClick={() => showPanel('Changes')}>
							Review
						</Btn>
						{!open ? <IconBtn icon={PanelRight} size="sm" label="Show workspace" onClick={() => setOpen(true)} /> : null}
					</header>
					<Thread sessionId={sessionId} agent={agent} />
				</div>
			) : null}
			{open ? (
				<VmPanel
					sessionId={sessionId}
					tabs={tabs}
					active={active}
					onTabsChange={setTabs}
					onActiveChange={setActive}
					expanded={expanded}
					onToggleExpanded={() => setExpanded((current) => !current)}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</div>
	);
}
