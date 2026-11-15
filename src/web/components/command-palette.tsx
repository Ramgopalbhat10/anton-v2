import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CircleCheck, FolderKanban, GitPullRequest, type LucideIcon, Plus, Search, Settings, Shapes, Inbox, ListTodo } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { SECTION_LIST } from '@/components/settings/section-list';
import { Badge, Icon, Kbd, SectionLabel } from '@/components/signal';
import { api, repoShort } from '@/lib/api';
import { age } from '@/lib/format';
import { useCreateChat } from '@/lib/create-chat';
import { openSettings } from '@/lib/settings-modal';
import { chooseProject, useProjects } from '@/lib/projects';
import { useSpaces } from '@/lib/spaces';
import { cn } from '@/lib/utils';
import { TaskStatusIcon } from '@/components/task-status';

type Entry = {
	id: string;
	label: string;
	/** The kind or context shown at the row's right edge. */
	meta: string;
	icon: LucideIcon;
	/** Drawn in the icon's place: a task's state glyph, as the sidebar shows it. */
	mark?: ReactNode;
	/** Where the row goes, so ⌘↵ can open it in a new tab. */
	href?: string;
	onSelect: () => void;
};

type Group = { label: string; entries: Entry[] };

const PAGES = [
	{ to: '/inbox', label: 'Inbox', icon: Inbox },
	{ to: '/tasks', label: 'Tasks', icon: ListTodo },
	{ to: '/reviews', label: 'Reviews', icon: GitPullRequest },
	{ to: '/projects', label: 'Projects', icon: FolderKanban },
	{ to: '/artifacts', label: 'Artifacts', icon: Shapes },
] as const;

/** ⌘K palette: describe a task to start it, or jump to an existing one. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
	const navigate = useNavigate();
	const create = useCreateChat();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, enabled: open });
	const projects = useProjects();
	// The repo the last task used; none when it was a chat, or there are no repos, so a prompt starts a chat.
	const project = chooseProject(projects.data?.projects ?? []);
	const spaces = useSpaces();
	const [query, setQuery] = useState('');
	const [index, setIndex] = useState(0);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) {
			setQuery('');
			setIndex(0);
			return;
		}
		// A menu closing underneath can hand focus back to its trigger; take it after.
		const frame = requestAnimationFrame(() => input.current?.focus());
		function onKey(event: KeyboardEvent) {
			if (event.key === 'Escape') onClose();
		}
		window.addEventListener('keydown', onKey);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('keydown', onKey);
		};
	}, [open, onClose]);

	const groups = useMemo<Group[]>(() => {
		const needle = query.trim().toLowerCase();
		const spaceName = new Map((spaces.data?.spaces ?? []).map((space) => [space.id, space.name]));
		const actions: Entry[] = [
			{
				id: 'action-settings',
				label: 'Open settings',
				meta: 'Action',
				icon: Settings,
				onSelect: () => {
					onClose();
					openSettings();
				},
			},
		].filter((entry) => !needle || entry.label.toLowerCase().includes(needle));
		const projects = (spaces.data?.spaces ?? [])
			.filter((space) => space.state !== 'archived' && (!needle || space.name.toLowerCase().includes(needle)))
			.slice(0, needle ? 5 : 3)
			.map((space): Entry => ({
				id: space.id,
				label: space.name,
				meta: space.counts.waiting ? `Project · ${space.counts.waiting === 1 ? 'needs you' : `${space.counts.waiting} need you`}` : 'Project',
				icon: FolderKanban,
				href: `/projects/${space.id}`,
				onSelect: () => {
					onClose();
					void navigate({ to: '/projects/$spaceId', params: { spaceId: space.id } });
				},
			}));
		const tasks = (sessions.data?.sessions ?? [])
			.filter((session) => !needle || session.title.toLowerCase().includes(needle))
			.slice(0, 8)
			.map((session): Entry => {
				const href = session.spaceId
					? `/projects/${session.spaceId}/threads/${session.id}`
					: `/agents/${session.id}?app=code`;
				return {
					id: session.id,
					label: session.title,
					meta: `${session.spaceId ? `${spaceName.get(session.spaceId) ?? 'Project'} · ` : ''}${repoShort(session)} · ${age(session.createdAt)}`,
					icon: CircleCheck,
					mark: <TaskStatusIcon session={session} size={12} />,
					href,
					onSelect: () => {
						onClose();
						if (session.spaceId) void navigate({ to: '/projects/$spaceId/threads/$threadId', params: { spaceId: session.spaceId, threadId: session.id } });
						else void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code' } });
					},
				};
			});
		// Settings pages only once something is typed, so the list stays about tasks.
		const settings = SECTION_LIST.filter((section) => needle && section.label.toLowerCase().includes(needle)).map((section): Entry => ({
			id: `settings-${section.id}`,
			label: section.label,
			meta: 'Settings',
			icon: section.icon,
			href: `/settings/${section.id}`,
			onSelect: () => {
				onClose();
				void navigate({ to: '/settings/$section', params: { section: section.id } });
			},
		}));
		const pages = PAGES.filter((page) => needle && page.label.toLowerCase().includes(needle)).map((page): Entry => ({
			...page,
			id: `page-${page.to}`,
			meta: 'Page',
			href: page.to,
			onSelect: () => {
				onClose();
				void navigate({ to: page.to });
			},
		}));
		return [
			{ label: 'Actions', entries: actions },
			{ label: 'Projects', entries: projects },
			{ label: 'Tasks', entries: tasks },
			{ label: 'Pages', entries: pages },
			{ label: 'Settings', entries: settings },
		].filter((group) => group.entries.length > 0);
	}, [sessions.data, spaces.data, query, navigate, onClose]);

	if (!open) return null;

	const flat = groups.flatMap((group) => group.entries);
	const count = flat.length + 1;
	const active = index === 0 ? null : (flat[index - 1] ?? null);

	function start() {
		onClose();
		const prompt = query.trim();
		if (prompt && projects.isSuccess) create({ prompt, projectId: project?.id, repo: project?.repoFullName });
		else void navigate({ to: '/' });
	}

	function choose(position: number, freshTab = false) {
		if (position === 0) {
			if (!freshTab) start();
			return;
		}
		const entry = flat[position - 1];
		if (!entry) return;
		if (freshTab) {
			if (entry.href) window.open(entry.href, '_blank', 'noopener');
			return;
		}
		entry.onSelect();
	}

	return (
		<div
			className="fixed inset-0 z-[200] flex items-start justify-center bg-(--bg-scrim) px-4 pt-[14vh] pb-4 backdrop-blur-[2px]"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				role="dialog"
				aria-label="Command palette"
				className="in-pop in-pop--modal flex w-[min(640px,100%)] flex-col overflow-hidden"
			>
				<div className="flex h-[52px] items-center gap-2.5 px-4 shadow-[inset_0_-1px_0_var(--line)]">
					<Icon icon={Search} size={16} className="text-(--text-3)" />
					<input
						ref={input}
						autoFocus
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setIndex(0);
						}}
						onKeyDown={(event) => {
							if (event.key === 'ArrowDown') {
								event.preventDefault();
								setIndex((current) => (current + 1) % count);
							} else if (event.key === 'ArrowUp') {
								event.preventDefault();
								setIndex((current) => (current - 1 + count) % count);
							} else if (event.key === 'Enter') {
								event.preventDefault();
								choose(index, event.metaKey || event.ctrlKey);
							}
						}}
						placeholder="Type a command, or describe a task"
						className="min-w-0 flex-1 border-0 bg-transparent p-0 text-body-lg text-(--text) outline-none placeholder:text-(--text-4)"
					/>
					<Badge>Everything</Badge>
				</div>
				<div className="flex max-h-[52vh] flex-col gap-px overflow-y-auto p-1.5">
					<button
						type="button"
						onMouseEnter={() => setIndex(0)}
						onClick={() => choose(0)}
						className={cn(
							'relative flex h-[34px] shrink-0 items-center gap-2.5 rounded-inner px-2.5 text-left',
							index === 0 ? 'bg-(--bg-active)' : 'hover:bg-(--bg-hover)',
						)}
					>
						<Icon icon={Plus} size={15} className="text-(--text-3)" />
						<div className="min-w-0 flex-1 truncate text-body">
							{project || !projects.isSuccess ? 'Start a task' : 'Start a chat'}{' '}
							<span className="text-(--text-3)">{query.trim() ? `“${query.trim()}”` : 'with a prompt…'}</span>
						</div>
						<Kbd keys="enter" />
					</button>
					{groups.map((group) => (
						<Fragment key={group.label}>
							<SectionLabel className="px-2.5 pt-3 pb-1">{group.label}</SectionLabel>
							{group.entries.map((entry) => {
								const position = flat.indexOf(entry) + 1;
								return (
									<button
										type="button"
										key={entry.id}
										onMouseEnter={() => setIndex(position)}
										onClick={() => choose(position)}
										className={cn(
											'flex h-[34px] shrink-0 items-center gap-2.5 rounded-inner px-2.5 text-left text-(--text)',
											index === position && 'bg-(--bg-active)',
										)}
									>
										{entry.mark ?? <Icon icon={entry.icon} size={15} className="text-(--text-3)" />}
										<div className="min-w-0 flex-1 truncate text-body">{entry.label}</div>
										<div className="text-small whitespace-nowrap text-(--text-3)">{entry.meta}</div>
									</button>
								);
							})}
						</Fragment>
					))}
				</div>
				<div className="flex h-9 shrink-0 items-center gap-3.5 bg-(--bg-panel) px-3.5 text-small text-(--text-3) shadow-[inset_0_1px_0_var(--line)]">
					<span className="flex items-center gap-1">
						<Kbd keys="↑+↓" />
						Move
					</span>
					<span className="flex items-center gap-1">
						<Kbd keys="enter" />
						{active ? 'Open' : 'Start'}
					</span>
					{active?.href ? (
						<span className="hidden items-center gap-1 sm:flex">
							<Kbd keys="mod+enter" />
							Open in new tab
						</span>
					) : null}
					<span className="min-w-0 flex-1" />
					<span className="flex items-center gap-1">
						<Kbd keys="esc" />
						Close
					</span>
				</div>
			</div>
		</div>
	);
}
