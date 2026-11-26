import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { type CSSProperties, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ChatSidebar } from '@/components/shell/chat-sidebar';
import { CommandPalette } from '@/components/shell/command-palette';
import { MobileNav } from '@/components/shell/mobile-nav';
import { ErrorBoundary } from '@/components/kit/error-boundary';
import { ResizeHandle, useStoredState } from '@/components/kit/split-pane';
import { Launcher } from '@/components/pages/launcher';
import { NavContext } from '@/components/kit/nav';
import { useLiveUpdates } from '@/lib/live-updates';
import { useTaskNotifications } from '@/lib/notifications';
import { serviceWorker, turnOnIfAllowed, useOpenFromNotifications, usePresence } from '@/lib/push';
import { ProjectSettingsModal } from '@/components/projects/project-settings-modal';
import { SettingsModal } from '@/components/settings/modal';
import { DeletionFailures } from '@/components/shell/deletion-failures';
import { cn } from '@/lib/utils';

function readCollapsed() {
	try {
		return localStorage.getItem('anton.sidebar') === 'collapsed';
	} catch {
		return false;
	}
}

/** The width where the sidebar can collapse to its icon rail (`md` in aura-components.css); below it the sidebar is a full drawer whatever was saved. */
const RAIL_QUERY = '(min-width: 768px)';
const railMedia = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(RAIL_QUERY) : null);
function subscribeRail(onChange: () => void): () => void {
	const list = railMedia();
	list?.addEventListener('change', onChange);
	return () => list?.removeEventListener('change', onChange);
}
function useRailWidth(): boolean {
	return useSyncExternalStore(subscribeRail, () => railMedia()?.matches ?? true, () => true);
}

/** Its own component, so a change to the task list does not re-render the whole shell. */
function TaskNotifications() {
	useTaskNotifications();
	useOpenFromNotifications();
	usePresence();
	useEffect(() => {
		void serviceWorker().then(() => turnOnIfAllowed());
	}, []);
	return null;
}

const FLOATING = 'fixed right-4 bottom-4 z-50 max-w-[320px] shadow-(--sh-1)';

const NAV_DEFAULT = 236;
const NAV_MIN = 200;
const NAV_MAX = 420;

export function AppShell() {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const [navOpen, setNavOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const railWidth = useRailWidth();
	const [storedWidth, setNavWidth] = useStoredState('anton.sidebarWidth', NAV_DEFAULT);
	// A width saved under other limits, or not a number at all, comes back inside these.
	const navWidth = Number.isFinite(storedWidth) ? Math.min(NAV_MAX, Math.max(NAV_MIN, storedWidth)) : NAV_DEFAULT;
	const [paletteOpen, setPaletteOpen] = useState(false);
	const navigate = useNavigate();
	// An incognito chat shows no sidebar: its frame covers the whole page.
	const incognito = pathname === '/incognito';
	const closePalette = useCallback(() => setPaletteOpen(false), []);
	const closeNav = useCallback(() => setNavOpen(false), []);
	// The same function on every render, so nothing that opens the sidebar draws again when the shell does.
	const openNav = useCallback(() => setNavOpen(true), []);
	const collapse = useCallback(() => setCollapsed(true), []);
	const expand = useCallback(() => setCollapsed(false), []);
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
				return;
			}
			// C starts a new task from anywhere a key is not meant for a field, a menu, a dialog or the terminal.
			if (event.key.toLowerCase() !== 'c' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest('input, textarea, select, canvas, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], .xterm, .cm-editor')) return;
			if (document.querySelector('[role="dialog"], [role="menu"]')) return;
			event.preventDefault();
			setNavOpen(false);
			void navigate({ to: '/' });
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [navigate]);

	return (
		<NavContext.Provider value={openNav}>
			{/* Padded by the safe-area insets, so on a phone the app clears its notch and home bar. */}
			<div className="flex h-dvh overflow-hidden bg-(--bg-app) pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-body leading-[18px] text-(--text)">
				<button
					type="button"
					aria-label="Close sidebar"
					tabIndex={navOpen ? 0 : -1}
					data-shown={navOpen}
					className="sg-nav-scrim fixed inset-0 z-20 bg-(--bg-scrim) md:hidden"
					onClick={() => setNavOpen(false)}
				/>
				{/* The column narrows over a sidebar that never moves, so the page slides across it like a sheet and the icons that stay keep their place. */}
				{incognito ? null : (
					<div className="sg-nav-column" data-collapsed={collapsed} style={{ '--nav-w': `${navWidth}px` } as CSSProperties}>
						{collapsed ? null : (
							<ResizeHandle
								label="Resize the sidebar"
								width={navWidth}
								min={NAV_MIN}
								max={NAV_MAX}
								initial={NAV_DEFAULT}
								onResize={setNavWidth}
								// No edge of its own: the line shows only under the pointer, the keyboard or a drag.
								className="absolute inset-y-0 right-0 z-10 hidden w-2 before:bg-transparent md:flex"
							/>
						)}
						<ErrorBoundary label="The sidebar" className="m-3">
							<ChatSidebar
								open={navOpen}
								collapsed={collapsed && railWidth}
								onNavigate={closeNav}
								onCollapse={collapse}
								onExpand={expand}
								onOpenPalette={openPalette}
							/>
						</ErrorBoundary>
					</div>
				)}
				<main className={cn('app-main flex min-h-0 min-w-0 flex-1 flex-col', incognito ? 'app-main--alone' : 'max-md:pb-14')}>
					<Outlet />
				</main>
				{incognito ? null : <MobileNav onNew={openPalette} />}
				<ErrorBoundary label="The command palette" className={FLOATING}>
					<CommandPalette open={paletteOpen} onClose={closePalette} />
				</ErrorBoundary>
				<ErrorBoundary label="Settings" className={FLOATING}>
					<SettingsModal />
				</ErrorBoundary>
				<ErrorBoundary label="Project settings" className={FLOATING}>
					<ProjectSettingsModal />
				</ErrorBoundary>
				<TaskNotifications />
				<DeletionFailures className={FLOATING} />
			</div>
		</NavContext.Provider>
	);
}

export function HomePage() {
	return <Launcher />;
}
