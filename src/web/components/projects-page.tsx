import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, FolderGit2, FolderKanban, MessageSquare, Moon, Plus, Search, Settings, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { ProjectArt } from '@/components/illustrations';
import { Caption } from '@/components/instrument';
import { IconPicker, suggestIcon } from '@/components/project-icon';
import { SpaceMark } from '@/components/project-sidebar';
import { activity, ActivityBars } from '@/components/project-viz';
import { AREA } from '@/components/repo-settings';
import { FIELD } from '@/components/settings/parts';
import { Btn, EmptyState, Icon, IconBtn, SearchField, Spinner } from '@/components/signal';
import { MenuButton } from '@/components/nav';
import { useNow } from '@/components/subagents';
import { ThreadStateIcon } from '@/components/thread-card';
import { api, type Space } from '@/lib/api';
import { age } from '@/lib/format';
import { useProjects } from '@/lib/projects';
import { stateOf, threadActiveAt, useSpaces, useThreads } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/** Rows a card keeps room for, so cards in a row line up whatever each holds. */
const CARD_ROWS = 3;

/**
 * A project as a quiet card: its mark and goal, three figures (open threads,
 * what needs you, what works) over a strip of its recent activity, its
 * repositories as outline badges, and its latest open threads underneath.
 * The whole card opens the project; the gear opens its settings.
 */
function ProjectCard({ space }: { space: Space }) {
	const { threads } = useThreads(space.id);
	const open = threads.filter((thread) => stateOf(thread) !== 'resolved');
	const counts = space.counts;
	const openCount = Object.entries(counts).reduce((total, [state, count]) => (state === 'resolved' ? total : total + count), 0);
	const now = useNow(false);
	const repos = space.repos.slice(0, 3);
	const extra = space.repos.length - repos.length;
	return (
		<div className={cn('in-card relative overflow-hidden transition-shadow duration-(--t) hover:shadow-(--sh-1)', space.state === 'archived' && 'opacity-70')}>
			<Link to="/projects/$spaceId" params={{ spaceId: space.id }} aria-label={`Open ${space.name}`} className="absolute inset-0 rounded-card outline-none focus-visible:shadow-(--focus)" />
			<div className="pointer-events-none flex min-w-0 flex-1 flex-col">
				<div className="flex items-start gap-2.5 px-3.5 pt-3.5">
					<SpaceMark space={space} size={28} />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<div className="flex items-center gap-1.5">
							<span className="min-w-0 flex-1 truncate text-body font-semibold text-(--text)">{space.name}</span>
							{space.state !== 'active' ? <span className="shrink-0 text-micro font-medium text-(--warn)">{space.state === 'paused' ? 'Paused' : 'Archived'}</span> : null}
						</div>
						<span className="truncate text-small text-(--text-3)" title={space.goal || undefined}>
							{space.goal || 'No goal yet. Tell the coordinator what this project is for.'}
						</span>
					</div>
					<Link
						to="/projects/$spaceId/settings"
						params={{ spaceId: space.id }}
						aria-label={`${space.name} settings`}
						className="pointer-events-auto relative -mr-1.5 -mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-control text-(--text-3) outline-none transition-colors hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
					>
						<Icon icon={Settings} size={13} />
					</Link>
				</div>
				<div className="flex items-start gap-4 px-3.5 pt-3">
					<div className="flex flex-col">
						<span className="in-num text-body font-semibold text-(--text)">{openCount}</span>
						<span className="text-micro text-(--text-3)">Open</span>
					</div>
					<div className="flex flex-col">
						<span className={cn('in-num text-body font-semibold', counts.waiting ? 'text-(--warn)' : 'text-(--text)')}>{counts.waiting}</span>
						<span className="whitespace-nowrap text-micro text-(--text-3)">Needs you</span>
					</div>
					<div className="flex flex-col">
						<span className="in-num text-body font-semibold text-(--text)">{counts.working}</span>
						<span className="text-micro text-(--text-3)">Working</span>
					</div>
					<span className="min-w-2 flex-1" />
					<ActivityBars bars={activity(threads, now, 14).bars} height={14} className="mt-0.5 w-[96px] shrink-0" />
				</div>
				<div className="flex min-h-[22px] flex-wrap items-center gap-1 px-3.5 pt-2.5">
					{repos.map((repo) => (
						<span key={repo.id} title={repo.repoFullName} className="inline-flex h-[20px] max-w-[48%] min-w-0 items-center gap-1 rounded-inner px-1.5 text-micro font-medium text-(--text-2) shadow-[inset_0_0_0_1px_var(--line-strong)]">
							<Icon icon={FolderGit2} size={10} className="shrink-0 text-(--text-3)" />
							<span className="truncate">{repo.repoFullName.split('/').pop()}</span>
						</span>
					))}
					{extra > 0 ? <span className="inline-flex h-[20px] items-center rounded-inner px-1.5 text-micro font-medium text-(--text-3) shadow-[inset_0_0_0_1px_var(--line-strong)]">+{extra}</span> : null}
					{space.repos.length === 0 ? (
						<span className="inline-flex h-[20px] items-center gap-1 rounded-inner px-1.5 text-micro font-medium text-(--text-3) shadow-[inset_0_0_0_1px_var(--line-strong)]">
							<Icon icon={MessageSquare} size={10} className="shrink-0" />
							Chats only
						</span>
					) : null}
				</div>
				<div className="mx-3.5 mt-3 border-t border-(--line)" />
				<div className="flex flex-col px-1.5 pt-1 pb-1.5" style={{ minHeight: CARD_ROWS * 26 }}>
					{open.length ? (
						open.slice(0, CARD_ROWS).map((thread) => (
							<div key={thread.id} className="flex h-[26px] items-center gap-2 px-1.5">
								<ThreadStateIcon thread={thread} size={12} />
								<span className="min-w-0 flex-1 truncate text-small text-(--text-2)">{thread.title}</span>
								<span className="in-num shrink-0 text-micro text-(--text-4)">{age(threadActiveAt(thread))}</span>
							</div>
						))
					) : (
						<div className="flex flex-1 items-center justify-center gap-1.5 text-small text-(--text-4)" style={{ minHeight: CARD_ROWS * 26 }}>
							<Icon icon={Moon} size={12} />
							All quiet{space.activeAt ? ` · active ${age(space.activeAt)} ago` : ''}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/** The projects at a glance, over the cards: how many, what needs you, what works, what is open. */
function Summary({ spaces }: { spaces: Space[] }) {
	const sum = (pick: (space: Space) => number) => spaces.reduce((total, space) => total + pick(space), 0);
	const waiting = sum((space) => space.counts.waiting);
	const open = sum((space) => Object.entries(space.counts).reduce((total, [state, count]) => (state === 'resolved' ? total : total + count), 0));
	const items: Array<[string, number, string?]> = [
		[spaces.length === 1 ? 'project' : 'projects', spaces.length],
		[open === 1 ? 'open thread' : 'open threads', open],
		[waiting === 1 ? 'needs you' : 'need you', waiting, 'text-(--warn)'],
	];
	return (
		<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-small text-(--text-3)">
			{items.map(([label, value, tone]) => (
				<span key={label} className="inline-flex items-baseline gap-1">
					<span className={cn('in-num font-semibold text-(--text)', tone)}>{value}</span>
					{label}
				</span>
			))}
		</div>
	);
}

/** Name, goal and, optionally, repositories for a new project, and a first message for its coordinator. */
function NewProjectDialog({ onClose }: { onClose: () => void }) {
	const navigate = useNavigate();
	const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const queryClient = useQueryClient();
	const projects = useProjects();
	const [name, setName] = useState('');
	const [icon, setIcon] = useState<string | null>(null);
	const mark = icon ?? suggestIcon(name);
	const [goal, setGoal] = useState('');
	const [repoIds, setRepoIds] = useState<string[]>([]);
	const [ask, setAsk] = useState('');
	const create = useMutation({
		mutationFn: () => api.createSpace({ name: name.trim(), icon: mark, goal: goal.trim(), repoIds }),
		onSuccess: (space) => {
			void queryClient.invalidateQueries({ queryKey: ['spaces'] });
			onClose();
			void navigate({ to: '/projects/$spaceId', params: { spaceId: space.id }, search: ask.trim() ? { ask: ask.trim() } : {} });
		},
	});
	const toggle = (id: string) => setRepoIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-40 bg-(--bg-scrim)" />
				<Dialog.Content aria-describedby={undefined} onCloseAutoFocus={(event) => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }} className="in-card fixed top-[10vh] left-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 flex-col overflow-hidden shadow-(--sh-3)">
			<form
				className="flex min-h-0 flex-col"
				onSubmit={(event) => {
					event.preventDefault();
					create.mutate();
				}}
			>
				<header className="flex items-center gap-2 border-b border-(--line) px-4 py-3">
					<Icon icon={FolderKanban} size={14} className="text-(--accent-text)" />
					<Dialog.Title className="flex-1 text-body-lg font-medium">New project</Dialog.Title>
					<IconBtn icon={X} size="sm" label="Close" onClick={onClose} />
				</header>
				<div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3.5">
					<div className="flex items-center gap-2.5">
						<IconPicker value={mark} name={name} onChange={setIcon} size={36} />
						<input autoFocus aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, like Billing v2" className={`${FIELD} h-9 flex-1`} />
					</div>
					<textarea aria-label="Goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={2} placeholder="Goal: what this project is for" className={`${AREA} text-body leading-[19px]`} />
					<div className="flex flex-col gap-1.5">
						<Caption>Repositories · optional · {repoIds.length ? 'threads work on one each' : 'without one, threads work as chats'}</Caption>
						<div className="flex flex-col gap-1">
							{projects.isPending ? <Spinner size={12} /> : null}
							{(projects.data?.projects ?? []).map((project) => {
								const on = repoIds.includes(project.id);
								return (
									<button
										key={project.id}
										type="button"
										aria-pressed={on}
										onClick={() => toggle(project.id)}
										className={cn(
											'flex h-9 items-center gap-2.5 rounded-card border px-2.5 text-left text-body outline-none focus-visible:shadow-(--focus)',
											on ? 'border-(--accent-line) bg-(--accent-soft) text-(--text)' : 'border-(--line) bg-(--bg-raised) text-(--text-2) hover:border-(--line-strong)',
										)}
									>
										<Icon icon={FolderGit2} size={13} className={on ? 'text-(--accent-text)' : 'text-(--text-3)'} />
										<span className="min-w-0 flex-1 truncate">{project.repoFullName}</span>
										{on ? <Icon icon={Check} size={13} className="text-(--accent-text)" /> : null}
									</button>
								);
							})}
							{projects.data && projects.data.projects.length === 0 ? (
								<span className="text-small text-(--text-3)">
									No repositories yet. You can{' '}
									<Link to="/settings/$section" params={{ section: 'repos' }} className="text-(--accent-text) hover:underline">
										add one in Settings
									</Link>{' '}
									and to the project later.
								</span>
							) : null}
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<label htmlFor="project-first-message" className="in-caption">First message to the coordinator · optional</label>
						<textarea id="project-first-message" value={ask} onChange={(event) => setAsk(event.target.value)} rows={3} placeholder="Split the billing rewrite into threads: the schema change, the API, and the settings page." className={`${AREA} text-body leading-[19px]`} />
					</div>
				</div>
				<footer className="flex items-center gap-2 border-t border-(--line) px-4 py-2.5">
					{create.isError ? <span className="min-w-0 flex-1 text-small text-(--bad)">{create.error.message}</span> : <span className="flex-1" />}
					<Btn size="sm" variant="ghost" onClick={onClose}>
						Cancel
					</Btn>
					<Btn type="submit" size="sm" variant="primary" icon={Plus} disabled={!name.trim() || create.isPending}>
						{create.isPending ? 'Creating…' : 'Create project'}
					</Btn>
				</footer>
			</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** Every project, waiting ones first, and the way to make a new one. */
export function ProjectsPage() {
	const search = useSearch({ from: '/projects' });
	const navigate = useNavigate();
	const spaces = useSpaces();
	const [query, setQuery] = useState('');
	const [creating, setCreating] = useState(Boolean(search.create));
	useEffect(() => {
		if (search.create) {
			setCreating(true);
			void navigate({ to: '/projects', search: {}, replace: true });
		}
	}, [search.create]);
	const list = [...(spaces.data?.spaces ?? [])].sort((a, b) => Number(a.state === 'archived') - Number(b.state === 'archived') || b.counts.waiting - a.counts.waiting || b.activeAt.localeCompare(a.activeAt));
	const active = list.filter((space) => space.state !== 'archived');
	const needle = query.trim().toLowerCase();
	const shown = needle
		? list.filter((space) => `${space.name} ${space.goal} ${space.repos.map((repo) => repo.repoFullName).join(' ')}`.toLowerCase().includes(needle))
		: list;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-3 pl-2 md:pl-4">
				<MenuButton />
				<nav aria-label="Where you are" className="flex min-w-0 shrink-0 items-center text-body">
					<span className="font-medium text-(--text)">Projects</span>
				</nav>
				<span className="min-w-2 flex-1" />
				<SearchField value={query} onChange={setQuery} placeholder="Search projects" label="Search projects" className="hidden w-[200px] shrink-0 md:flex" />
				<Btn size="sm" variant="primary" icon={Plus} onClick={() => setCreating(true)} className="shrink-0">
					New project
				</Btn>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5 px-6 py-7 md:px-8">
					<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
						<div className="flex min-w-0 flex-col gap-1">
							<h1 className="m-0 text-h1 font-semibold tracking-[-0.01em] text-(--text)">Projects</h1>
							<p className="m-0 max-w-[560px] text-body text-(--text-3)">A goal, its repositories, and a coordinator that runs threads in parallel.</p>
						</div>
						{active.length > 0 ? <Summary spaces={active} /> : null}
					</div>
					{spaces.isPending ? <Spinner size={13} /> : null}
					{spaces.isError ? (
						<div role="alert" className="in-card flex flex-wrap items-center gap-3 p-4 text-body text-(--text-2)">
							Unable to load projects. Check your connection and try again.
							<Btn size="sm" onClick={() => void spaces.refetch()}>
								Try again
							</Btn>
						</div>
					) : null}
					{spaces.data && list.length === 0 ? (
						<EmptyState
							art={<ProjectArt className="w-full max-w-[360px]" />}
							title="Run several threads at once"
							body="A project groups work under one goal, with or without repositories. Its coordinator splits the work into threads that run in parallel, each in its own sandbox, and tells you which need you."
						>
							<Btn size="sm" variant="primary" icon={Plus} onClick={() => setCreating(true)}>
								New project
							</Btn>
						</EmptyState>
					) : null}
					{shown.length ? (
						<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
							{shown.map((space) => (
								<ProjectCard key={space.id} space={space} />
							))}
							<button
								type="button"
								onClick={() => setCreating(true)}
								className="group/new flex min-h-[190px] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-(--line-strong) px-6 text-center outline-none transition-colors hover:border-(--accent-line) hover:bg-(--accent-soft) focus-visible:shadow-(--focus)"
							>
								<span className="inline-flex size-9 items-center justify-center rounded-full bg-(--bg-active) text-(--text-2) group-hover/new:bg-(--accent-soft) group-hover/new:text-(--accent-text)">
									<Icon icon={Plus} size={16} />
								</span>
								<span className="text-body font-medium text-(--text-2) group-hover/new:text-(--text)">New project</span>
								<span className="max-w-[220px] text-small leading-4 text-(--text-4)">A goal, its repositories, and a coordinator that runs threads in parallel.</span>
							</button>
						</div>
					) : list.length ? (
						<EmptyState icon={Search} title="No projects match" body="Try another search." />
					) : null}
				</div>
			</div>
			{creating ? <NewProjectDialog onClose={() => setCreating(false)} /> : null}
		</div>
	);
}
