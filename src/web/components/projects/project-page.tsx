import { useFlueAgent } from '@flue/react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Popover } from 'radix-ui';
import { ChevronRight, FolderGit2, Maximize2, Minimize2, PanelRight, Plus, Settings, Waypoints, Workflow } from '@/lib/icons';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '@/lib/api';
import type { Space } from '@/lib/api/spaces';
import { PanelTab, PanelTabs, Status } from '@/components/kit/instrument';
import { MenuButton } from '@/components/kit/nav';
import { ProjectBoard } from '@/components/projects/project-board';
import { ProjectFeed, type TodoHandoff } from '@/components/projects/project-feed';
import { cacheStartedTodo, canStartTodo, todoThreadStartKey, useTodoSaves } from '@/components/projects/todo-saves';
import { ProjectActivity, ProjectFiles, ProjectPullRequests, ProjectRoutines } from '@/components/projects/project-panel';
import { SpaceMark } from '@/components/projects/project-sidebar';
import { useModelName, useModels } from '@/lib/models';
import { startingPanels, TaskWorkspace, type TaskPanels } from '@/components/shell/shell';
import { Badge, Btn, EmptyState, Icon, IconBtn } from '@/components/kit/signal';
import { useOnePane } from '@/lib/one-pane';
import { useOlderTurns, useWindowedClient } from '@/lib/conversation-window';
import { readThreadPanels, saveThreadPanels, useSpace, useSpaceTodos, useThreads } from '@/lib/spaces';
import { useStarting } from '@/lib/starting';
import { StartingTask } from '@/components/thread/starting-task';
import { usePaneSlide } from '@/components/workspace/workspace-pane';
import { openProjectSettings } from '@/lib/project-settings-modal';
import { cn } from '@/lib/utils';

type ProjectView = 'board' | 'files' | 'activity' | 'prs' | 'routines';

const VIEWS: Array<{ id: ProjectView; label: string }> = [
	{ id: 'board', label: 'Board' },
	{ id: 'files', label: 'Files' },
	{ id: 'activity', label: 'Activity' },
	{ id: 'prs', label: 'Pull requests' },
	{ id: 'routines', label: 'Routines' },
];

/** The tabs the right panel had before the board: their names map onto the views. */
const LEGACY_VIEW: Record<string, ProjectView> = { Overview: 'activity', Library: 'files', 'Pull requests': 'prs', Routines: 'routines' };

type DockState = { open: boolean; view: ProjectView };

const dockKey = (spaceId: string) => `anton.project-panel.${spaceId}`;

const DOCK_KEY = 'anton.project-dock-width';
const DOCK_DEFAULT = 380;
const DOCK_MIN = 320;
/** The width the board keeps beside the dock when it is dragged wider. */
const DOCK_RESERVE = 360;

function savedDockWidth(): number | null {
	try {
		const value = Number(localStorage.getItem(DOCK_KEY));
		return Number.isFinite(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

function readDock(spaceId: string): DockState {
	try {
		const saved = JSON.parse(localStorage.getItem(dockKey(spaceId)) ?? 'null') as { open?: boolean; view?: string; tab?: string } | null;
		const view = VIEWS.some((item) => item.id === saved?.view) ? (saved!.view as ProjectView) : (LEGACY_VIEW[saved?.tab ?? ''] ?? 'board');
		return { open: saved?.open ?? true, view };
	} catch {
		return { open: true, view: 'board' };
	}
}

function saveDock(spaceId: string, state: DockState) {
	try {
		localStorage.setItem(dockKey(spaceId), JSON.stringify(state));
	} catch {
		// Storage is a convenience; the dock still works without it.
	}
}

const repoName = (fullName: string) => fullName.split('/').filter(Boolean).pop() ?? fullName;

const REPO_CHIP = 'inline-flex h-[20px] min-w-0 items-center gap-1 rounded-inner px-1.5 text-micro font-medium text-(--text-3) shadow-[inset_0_0_0_1px_var(--line-strong)]';
const HEADER_FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function isShown(element: HTMLElement | null): boolean {
	if (!element || !element.isConnected) return false;
	for (let node: HTMLElement | null = element; node; node = node.parentElement) {
		if (node.hidden) return false;
		const style = getComputedStyle(node);
		if (style.display === 'none' || style.visibility === 'hidden') return false;
	}
	return true;
}

function fallbackHeaderControl(trigger: HTMLElement | null): HTMLElement | null {
	const header = trigger?.closest('header');
	if (!header) return null;
	const controls = [...header.querySelectorAll<HTMLElement>(HEADER_FOCUSABLE)];
	const index = trigger ? controls.indexOf(trigger) : -1;
	const ordered = index >= 0 ? [...controls.slice(index + 1), ...controls.slice(0, index)] : controls;
	return ordered.find((control) => control !== trigger && isShown(control)) ?? null;
}

/** Keeps hover as a non-focus-stealing preview while letting keyboard activation move focus into the scrollable list. */
function MultiRepoChip({ first, rest }: { first: Space['repos'][number]; rest: Space['repos'] }) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLUListElement>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const focusListOnOpen = useRef(false);
	const restoreFocus = useRef(false);
	const openedByHover = useRef(false);

	const clear = () => clearTimeout(timerRef.current);
	const focusList = () => listRef.current?.focus();
	const scheduleClose = () => {
		clear();
		if (!panelRef.current?.contains(document.activeElement)) {
			timerRef.current = setTimeout(() => setOpen(false), 80);
		}
	};

	useEffect(() => () => clearTimeout(timerRef.current), []);

	// The header hides the repo chip below `xl`; close its portalled popover if the anchor disappears and move focus to a visible header control when needed.
	useEffect(() => {
		if (!open) return;
		const closeIfHidden = () => {
			if (isShown(triggerRef.current)) return;
			const hadFocus = Boolean(panelRef.current?.contains(document.activeElement));
			clearTimeout(timerRef.current);
			restoreFocus.current = false;
			setOpen(false);
			if (hadFocus) fallbackHeaderControl(triggerRef.current)?.focus();
		};
		closeIfHidden();
		window.addEventListener('resize', closeIfHidden);
		const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(closeIfHidden) : null;
		if (observer && triggerRef.current) observer.observe(triggerRef.current);
		return () => {
			window.removeEventListener('resize', closeIfHidden);
			observer?.disconnect();
		};
	}, [open]);

	const engage = () => {
		clear();
		openedByHover.current = false;
		if (open) focusList();
		else {
			focusListOnOpen.current = true;
			setOpen(true);
		}
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen} modal={false}>
			<Popover.Anchor asChild>
				<button
					ref={triggerRef}
					type="button"
					aria-haspopup="dialog"
					aria-expanded={open}
					onPointerEnter={(event) => {
						if (event.pointerType === 'touch') return;
						clear();
						if (!open) {
							timerRef.current = setTimeout(() => {
								focusListOnOpen.current = false;
								openedByHover.current = true;
								setOpen(true);
							}, 120);
						}
					}}
					onPointerLeave={(event) => {
						if (event.pointerType === 'touch') return;
						scheduleClose();
					}}
					onClick={() => {
						if (open && !openedByHover.current) {
							clear();
							setOpen(false);
						} else {
							engage();
						}
					}}
					onKeyDown={(event) => {
						if (event.key !== 'ArrowDown') return;
						event.preventDefault();
						engage();
					}}
					className={cn(
						REPO_CHIP,
						'max-w-[180px] cursor-default outline-none transition-colors hover:bg-(--bg-hover) hover:text-(--text-2) focus-visible:shadow-(--focus)',
						open && 'bg-(--bg-hover) text-(--text-2)',
					)}
				>
					<Icon icon={FolderGit2} size={10} className="shrink-0" />
					<span className="truncate">{repoName(first.repoFullName)}</span>{' '}
					<span className="in-num shrink-0 text-(--text-4)">+{rest.length}</span>
				</button>
			</Popover.Anchor>
			<Popover.Portal>
				<Popover.Content
					ref={panelRef}
					side="bottom"
					align="end"
					sideOffset={6}
					collisionPadding={12}
					aria-label="Project repositories"
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						if (focusListOnOpen.current) {
							focusListOnOpen.current = false;
							focusList();
						}
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						if (!restoreFocus.current) return;
						restoreFocus.current = false;
						const target = isShown(triggerRef.current) ? triggerRef.current : fallbackHeaderControl(triggerRef.current);
						target?.focus();
					}}
					onEscapeKeyDown={() => {
						clear();
						restoreFocus.current = Boolean(panelRef.current?.contains(document.activeElement));
					}}
					onInteractOutside={(event) => {
						if (triggerRef.current?.contains(event.target as Node)) {
							event.preventDefault();
							return;
						}
						clear();
						restoreFocus.current = false;
					}}
					onPointerEnter={clear}
					onPointerLeave={(event) => {
						if (event.pointerType === 'touch') return;
						scheduleClose();
					}}
					onFocus={clear}
					onBlur={(event) => {
						const next = event.relatedTarget as Node | null;
						if (event.currentTarget.contains(next) || triggerRef.current?.contains(next)) return;
						clear();
						setOpen(false);
					}}
					onKeyDown={(event) => {
						if (event.key !== 'Tab') return;
						// The popover is portalled to document.body; move focus back to the trigger before Tab runs so focus continues naturally in header order.
						clear();
						restoreFocus.current = false;
						if (isShown(triggerRef.current)) {
							triggerRef.current?.focus();
						} else {
							event.preventDefault();
							fallbackHeaderControl(triggerRef.current)?.focus();
						}
						setOpen(false);
					}}
					className="in-pop z-50 flex w-max max-w-[280px] min-w-[180px] flex-col p-1 outline-none"
				>
					<div className="border-b border-(--line) px-2 py-1.5 text-micro font-medium text-(--text-3) [overflow-wrap:anywhere]">{first.repoFullName}</div>
					<ul
						ref={listRef}
						tabIndex={0}
						aria-label="More repositories"
						className="m-0 mt-1 flex max-h-[240px] list-none flex-col gap-0.5 overflow-y-auto rounded-inner p-0 outline-none focus-visible:shadow-(--focus)"
					>
						{rest.map((repo) => (
							<li key={repo.id} title={repo.repoFullName} className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-inner px-2 py-1 text-small font-medium text-(--text-2)">
								<Icon icon={FolderGit2} size={11} className="shrink-0 text-(--text-3)" />
								<span className="truncate">{repoName(repo.repoFullName)}</span>
							</li>
						))}
					</ul>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

export function ProjectReposChip({ repos }: { repos: Space['repos'] }) {
	if (repos.length === 0) return null;
	const [first, ...rest] = repos;
	if (rest.length === 0) {
		return (
			<span title={first.repoFullName} className={cn(REPO_CHIP, 'max-w-[160px]')}>
				<Icon icon={FolderGit2} size={10} className="shrink-0" />
				<span className="truncate">{repoName(first.repoFullName)}</span>
			</span>
		);
	}
	return <MultiRepoChip first={first} rest={rest} />;
}

export function ProjectPage() {
	const { spaceId } = useParams({ from: '/projects/$spaceId' });
	const search = useSearch({ from: '/projects/$spaceId' });
	const navigate = useNavigate();
	const space = useSpace(spaceId);
	const { threads } = useThreads(spaceId);
	const { todos } = useSpaceTodos(spaceId);
	const todoSaves = useTodoSaves(spaceId, todos);
	const path = `/api/agents/coordinator/${spaceId}`;
	const client = useWindowedClient(path);
	const agent = useOlderTurns(path, client, useFlueAgent({ client }));
	const queryClient = useQueryClient();
	const [handoffs, setHandoffs] = useState<TodoHandoff[]>([]);
	const heading = useRef<HTMLHeadingElement>(null);
	const hasConversation = useRef(false);
	hasConversation.current = agent.messages.some((message) => !message.id.startsWith('local:') || Boolean(message.submissionId));
	const handingOff = useMemo(() => new Set(handoffs.filter((entry) => entry.state !== 'failed').map((entry) => entry.todo.id)), [handoffs]);
	const [saved, setDock] = useState(() => readDock(spaceId));
	// On a phone the dock covers the board, so it shows only once you open it here; the saved choice is the wide screen's.
	const onePane = useOnePane();
	const [paneOpen, setPaneOpen] = useState(false);
	const dockOpen = onePane ? paneOpen : saved.open;
	const [expanded, setExpanded] = useState(false);
	const [starting, setStarting] = useState(Boolean(search.new));
	const [row, setRow] = useState<HTMLDivElement | null>(null);
	const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
	const [available, setAvailable] = useState(0);
	const [requested, setRequested] = useState(savedDockWidth);
	const [resizing, setResizing] = useState(false);
	const asked = useRef(false);
	const busy = agent.status === 'submitted' || agent.status === 'streaming' || handingOff.size > 0;
	const models = useModels();
	const modelName = useModelName();
	const coordinatorModel = space.data?.coordinatorModel ?? models.data?.default ?? '';
	const coordinatorName = coordinatorModel ? modelName(coordinatorModel) : '';
	const slide = usePaneSlide(dockOpen);

	useLayoutEffect(() => {
		if (!row) return;
		const measure = () => setAvailable(Math.round(row.getBoundingClientRect().width));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(row);
		return () => observer.disconnect();
	}, [row]);

	const changeDock = useCallback(
		(next: Partial<DockState>) => {
			if (onePane && next.open !== undefined) {
				setPaneOpen(next.open);
				if (!next.open) setExpanded(false);
				const { open: _open, ...rest } = next;
				next = rest;
			}
			setDock((current) => {
				const updated = { ...current, ...next };
				saveDock(spaceId, updated);
				if (!updated.open) setExpanded(false);
				return updated;
			});
		},
		[spaceId, onePane],
	);
	const openCoordinator = useCallback(() => changeDock({ open: true }), [changeDock]);
	const focusCoordinator = useCallback(() => heading.current?.focus({ preventScroll: true }), []);
	const refreshCoordinator = agent.refresh;
	const eligibleTodo = (id: string) => {
		const todo = todoSaves.todos.find((item) => item.id === id);
		return todo && !handingOff.has(id) && !todoSaves.isStartingThread(id) && canStartTodo(todo, todoSaves.stateOf(todo)) ? todo : undefined;
	};
	const handTodo = (id: string, focus = false) => {
		const todo = eligibleTodo(id);
		// The board's mutation enters the cache before observers redraw with its pending state.
		if (!todo || queryClient.isMutating({ mutationKey: [...todoThreadStartKey(spaceId), id], exact: true })) return;
		if (focus) focusCoordinator();
		openCoordinator();
		const update = (next: TodoHandoff | null) => setHandoffs((all) => {
			const others = all.filter((entry) => entry.todo.id !== todo.id);
			return next ? [...others, next] : others;
		});
		update({ todo, state: 'sending' });
		const key = ['space-todos', spaceId];
		void api.startSpaceTodo(spaceId, id, 'coordinator').then(({ todo: savedTodo, submissionId }) => {
			cacheStartedTodo(queryClient, spaceId, savedTodo);
			update(submissionId ? { todo, state: 'accepted', submissionId } : null);
			// The SDK stops observing a conversation that doesn't exist yet. Admission creates it.
			if (!hasConversation.current) refreshCoordinator();
		}, (error: unknown) => {
			update({ todo, state: 'failed', error: error instanceof Error ? error.message : String(error) });
		}).finally(() => void queryClient.invalidateQueries({ queryKey: key }));
	};

	const settlements = agent.settlements;
	useEffect(() => {
		if (!settlements.length || !handoffs.some((entry) => entry.state === 'accepted' && settlements.some((item) => item.submissionId === entry.submissionId))) return;
		const byId = new Map(settlements.map((item) => [item.submissionId, item]));
		setHandoffs((all) => {
			return all.flatMap((entry): TodoHandoff[] => {
				const settled = entry.state === 'accepted' ? byId.get(entry.submissionId) : undefined;
				if (!settled) return [entry];
				if (settled.outcome === 'completed') return [];
				const reason = settled.error;
				const detail = reason && typeof reason === 'object' && 'message' in reason ? reason.message : reason;
				return [{ todo: entry.todo, state: 'failed', error: typeof detail === 'string' ? detail.trim() : '', settlement: { submissionId: settled.submissionId, outcome: settled.outcome } }];
			});
		});
	}, [settlements, handoffs]);

	// A first message from the New project dialog goes to the coordinator once, then leaves the address.
	useEffect(() => {
		if (!search.ask || asked.current || !agent.historyReady) return;
		asked.current = true;
		void agent.sendMessage(search.ask);
		void navigate({ to: '/projects/$spaceId', params: { spaceId }, search: {}, replace: true });
	}, [search.ask, agent.historyReady]);

	// The new thread's form opens in the coordinator's conversation, so the board or view beside it stays.
	const startThread = useCallback(() => {
		setStarting(true);
		changeDock({ open: true });
	}, [changeDock]);

	useEffect(() => {
		if (search.new) {
			startThread();
			void navigate({ to: '/projects/$spaceId', params: { spaceId }, search: {}, replace: true });
		}
	}, [search.new]);

	if (space.isError) {
		return <EmptyState icon={Waypoints} title="No such project" body="It may have been deleted. Projects are listed in the sidebar." className="mt-24" />;
	}
	if (!space.data) return <div className="flex-1" />;
	const data = space.data;
	const centerVisible = !(dockOpen && (onePane || expanded));
	// Expanded or on a phone the dock covers the board, so it has no width of its own to keep.
	const covers = expanded || onePane;
	const minimum = Math.min(DOCK_MIN, available);
	const maximum = Math.max(minimum, available - DOCK_RESERVE);
	const clamp = (value: number) => Math.round(Math.min(maximum, Math.max(minimum, value)));
	const dockWidth = available ? clamp(requested ?? DOCK_DEFAULT) : DOCK_DEFAULT;
	const chooseDock = (value: number) => {
		const next = clamp(value);
		setRequested(next);
		try {
			localStorage.setItem(DOCK_KEY, String(next));
		} catch {
			// Resizing also works when browser storage is unavailable.
		}
	};

	return (
		<div ref={setRow} className="flex min-h-0 min-w-0 flex-1">
			<div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !centerVisible && 'hidden')}>
				<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-3 pl-2 md:pl-4">
					<MenuButton />
					<nav aria-label="Where you are" className="flex min-w-0 shrink-0 items-center gap-1.5 text-body">
						<Link to="/projects" className="shrink-0 rounded-control text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
							Projects
						</Link>
						<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--text-4)" />
						<SpaceMark space={data} size={16} />
						<span className="min-w-0 truncate font-medium text-(--text)">{data.name}</span>
						{busy ? (
							<Status tone="accent" pulse>
								Coordinating
							</Status>
						) : data.state !== 'active' ? (
							<Status tone="warning">{data.state === 'paused' ? 'Paused' : 'Archived'}</Status>
						) : null}
					</nav>
					<PanelTabs label="Project views" className="min-w-0 flex-1">
						{VIEWS.map((view) => (
							<PanelTab key={view.id} on={saved.view === view.id} onSelect={() => changeDock({ view: view.id })}>
								{view.label}
							</PanelTab>
						))}
					</PanelTabs>
					{data.repos.length > 0 ? (
						<div className="hidden shrink-0 items-center xl:flex">
							<ProjectReposChip repos={data.repos} />
						</div>
					) : null}
					<IconBtn icon={Settings} size="sm" label="Project settings" onClick={() => openProjectSettings(spaceId)} />
					<Btn size="sm" variant="primary" icon={Waypoints} onClick={startThread}>
						<span className="hidden sm:inline">New thread</span>
					</Btn>
					{!dockOpen ? <IconBtn icon={PanelRight} size="sm" label="Show the coordinator" onClick={() => changeDock({ open: true })} /> : null}
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{saved.view === 'board' ? (
						<ProjectBoard space={data} threads={threads} saves={todoSaves} onNewThread={startThread} onOpenCoordinator={openCoordinator} onHandTodo={handTodo} onHandoffFocus={focusCoordinator} handingOff={handingOff} />
					) : (
						<div className="mx-auto flex h-full w-full max-w-[960px] flex-col gap-3 px-4 py-4 md:px-6">
							{saved.view === 'files' ? <ProjectFiles space={data} threads={threads} /> : null}
							{saved.view === 'activity' ? <ProjectActivity space={data} threads={threads} /> : null}
							{saved.view === 'prs' ? <ProjectPullRequests threads={threads} /> : null}
							{saved.view === 'routines' ? <ProjectRoutines space={data} threads={threads} /> : null}
						</div>
					)}
				</div>
			</div>
			{slide ? (
			<aside
				aria-label="Coordinator"
				className={cn(
					'min-h-0 min-w-0 flex-col',
					covers ? cn('flex flex-1', slide === 'out' && 'hidden') : 'sg-project-dock relative flex border-l bg-(--bg-app)',
				)}
				data-slide={covers ? undefined : slide}
				data-resizing={resizing || undefined}
				style={covers ? undefined : ({ '--dock-width': available ? `${dockWidth}px` : `${DOCK_DEFAULT}px` } as CSSProperties)}
			>
				{!covers && slide === 'still' ? (
					<div
						role="separator"
						aria-label="Resize the coordinator"
						aria-orientation="vertical"
						aria-valuemin={minimum}
						aria-valuemax={maximum}
						aria-valuenow={dockWidth}
						aria-valuetext={`${dockWidth} pixels`}
						tabIndex={0}
						className="sg-workspace-resizer absolute inset-y-0 left-0 z-20 hidden w-1.5 cursor-col-resize touch-none outline-none md:block"
						onKeyDown={(event) => {
							const next = { ArrowLeft: dockWidth + 24, ArrowRight: dockWidth - 24, Home: minimum, End: maximum }[event.key];
							if (next === undefined) return;
							event.preventDefault();
							chooseDock(next);
						}}
						onPointerDown={(event) => {
							if (event.button !== 0) return;
							event.preventDefault();
							event.currentTarget.focus();
							event.currentTarget.setPointerCapture(event.pointerId);
							drag.current = { pointer: event.pointerId, x: event.clientX, width: dockWidth };
							setResizing(true);
						}}
						onPointerMove={(event) => {
							const start = drag.current;
							if (start?.pointer === event.pointerId) chooseDock(start.width + start.x - event.clientX);
						}}
						onPointerUp={(event) => {
							if (drag.current?.pointer !== event.pointerId) return;
							event.currentTarget.releasePointerCapture(event.pointerId);
							drag.current = null;
							setResizing(false);
						}}
						onLostPointerCapture={() => {
							drag.current = null;
							setResizing(false);
						}}
					/>
				) : null}
				<div className="sg-project-dock-body flex min-h-0 min-w-0 flex-1 flex-col">
				<div className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-2 pl-3.5">
					<Icon icon={Workflow} size={14} className="shrink-0 text-(--text-3)" />
					<h2 ref={heading} tabIndex={-1} className="m-0 min-w-0 flex-1 truncate rounded-control text-body font-medium text-(--text) outline-none focus-visible:shadow-(--focus)">Coordinator</h2>
					{coordinatorName ? (
						<span className="hidden shrink-0 sm:inline-flex">
							<Badge>{coordinatorName}</Badge>
						</span>
					) : null}
					<IconBtn
						icon={expanded ? Minimize2 : Maximize2}
						size="sm"
						label={expanded ? 'Restore the board' : 'Expand the coordinator'}
						onClick={() => setExpanded((current) => !current)}
						className="hidden md:inline-flex"
					/>
					<IconBtn icon={PanelRight} size="sm" label="Hide the coordinator" onClick={() => changeDock({ open: false })} />
				</div>
				<ProjectFeed space={data} agent={agent} threads={threads} starting={starting} onStartingChange={setStarting} handoffs={handoffs} canRetryHandoff={(id) => Boolean(eligibleTodo(id))} onRetryHandoff={(id) => handTodo(id, true)} />
				</div>
			</aside>
			) : null}
		</div>
	);
}

function typing(event: KeyboardEvent): boolean {
	const target = event.target as HTMLElement | null;
	if (!target || event.defaultPrevented) return true;
	if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .xterm')) return true;
	return Boolean(document.querySelector('[role="dialog"], [role="menu"]'));
}

/** Its workspace panels are kept per thread, so switching back finds them as they were. Escape goes back to the coordinator. */
export function ThreadPage() {
	const { spaceId, threadId } = useParams({ from: '/projects/$spaceId/threads/$threadId' });
	const search = useSearch({ from: '/projects/$spaceId/threads/$threadId' });
	const navigate = useNavigate();
	const space = useSpace(spaceId);
	const starting = useStarting(threadId);
	// Each time it opens, a thread shows the panels you pinned; whether its workspace was open is its own.
	const [panels, setPanels] = useState<TaskPanels>(() => {
		const start = startingPanels();
		return { ...start, open: readThreadPanels(threadId, start).open };
	});

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.key !== 'Escape' || typing(event)) return;
			void navigate({ to: '/projects/$spaceId', params: { spaceId } });
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [spaceId]);

	const leading = (
		<>
			<Link
				to="/projects/$spaceId"
				params={{ spaceId }}
				title="Back to the coordinator (Esc)"
				className="flex min-w-0 shrink items-center gap-1.5 rounded-control py-0.5 pr-1 text-body text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)"
			>
				{space.data ? <SpaceMark space={space.data} size={16} /> : null}
				<span className="hidden max-w-[160px] truncate sm:inline">{space.data?.name ?? 'Project'}</span>
			</Link>
			<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--text-4)" />
		</>
	);
	if (starting) return <StartingTask starting={starting} workspace={panels.open} narrow={panels.active === null} leading={leading} onDiscard={() => void navigate({ to: '/projects/$spaceId', params: { spaceId } })} />;
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
			leading={leading}
		/>
	);
}
