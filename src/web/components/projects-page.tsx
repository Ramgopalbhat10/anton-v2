import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowRight, Check, FolderGit2, FolderKanban, MessageSquare, Moon, Plus, X } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { ProjectArt } from '@/components/illustrations';
import { Caption } from '@/components/instrument';
import { PageFrame } from '@/components/page-frame';
import { IconPicker, iconTint, suggestIcon } from '@/components/project-icon';
import { SpaceMark } from '@/components/project-sidebar';
import { ProjectRack } from '@/components/project-rack';
import { activity, ActivityBars } from '@/components/project-viz';
import { AREA } from '@/components/repo-settings';
import { FIELD } from '@/components/settings/parts';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { useNow } from '@/components/subagents';
import { ThreadStateIcon } from '@/components/thread-card';
import { api, SAFETY_NET_MS, type Space } from '@/lib/api';
import { age } from '@/lib/format';
import { useProjects } from '@/lib/projects';
import { stateOf, threadActiveAt, useSpaces, useThreads } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/** One figure on a project card: a count over its word, lit when it asks for you. */
function Figure({ label, value, tone }: { label: string; value: number; tone?: 'attention' | 'accent' }) {
	return (
		<div className="flex min-w-0 flex-col gap-px rounded-tile bg-(--alpha-white-3) px-2.5 py-1.5">
			<span
				className={cn(
					'in-figure text-h3 leading-5',
					value === 0 && 'text-(--text-disabled)',
					value > 0 && tone === 'attention' && 'text-(--attention-text)',
					value > 0 && tone === 'accent' && 'text-(--accent-text)',
				)}
			>
				{value}
			</span>
			<span className="truncate text-micro text-(--text-tertiary)">{label}</span>
		</div>
	);
}

/** Rows a card keeps room for, so cards in a row line up whatever each holds. */
const CARD_ROWS = 3;

/**
 * A project as a card: its mark and goal over a wash of its own colour, three
 * figures (open threads, what needs you, what runs), its repositories by short
 * name, its latest open threads, and a footer with its recent activity.
 */
function ProjectCard({ space }: { space: Space }) {
	const { threads } = useThreads(space.id);
	const open = threads.filter((thread) => stateOf(thread) !== 'resolved');
	const counts = space.counts;
	const now = useNow(false);
	const tint = iconTint(space.icon);
	const repos = space.repos.slice(0, 3);
	const extra = space.repos.length - repos.length;
	return (
		<Link
			to="/projects/$spaceId"
			params={{ spaceId: space.id }}
			style={{ '--tint': tint } as CSSProperties}
			className={cn(
				'project-card group/card in-card relative flex min-w-0 flex-col overflow-hidden outline-none focus-visible:shadow-(--focus-ring)',
				space.state === 'archived' && 'opacity-70',
			)}
		>
			<span aria-hidden className="project-card__wash pointer-events-none absolute inset-x-0 top-0 h-24" />
			<div className="relative flex items-start gap-3 px-4 pt-4">
				<SpaceMark space={space} size={36} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-body-lg font-semibold tracking-[-0.01em] text-(--text-primary)">{space.name}</span>
						{space.state !== 'active' ? <Caption tone="warning">{space.state === 'paused' ? 'Paused' : 'Archived'}</Caption> : null}
						{counts.waiting > 0 ? (
							<span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-(--attention-bg) px-2 text-micro text-(--attention-text)">
								<span className="size-1.5 rounded-full bg-(--attention-base)" />
								Needs you
							</span>
						) : null}
					</div>
					<span className="line-clamp-2 min-h-[34px] text-small leading-[17px] text-(--text-tertiary)">{space.goal || 'No goal yet. Tell the coordinator what this project is for.'}</span>
				</div>
			</div>
			<div className="relative grid grid-cols-3 gap-1.5 px-4 pt-3.5">
				<Figure label="Open" value={open.length} />
				<Figure label="Needs you" value={counts.waiting} tone="attention" />
				<Figure label="Working" value={counts.working} tone="accent" />
			</div>
			<div className="flex min-h-[22px] flex-wrap items-center gap-1 px-4 pt-3">
				{repos.map((repo) => (
					<span key={repo.id} title={repo.repoFullName} className="inline-flex h-[22px] max-w-[48%] min-w-0 items-center gap-1 rounded-full bg-(--alpha-white-4) pr-2 pl-1.5 text-small text-(--text-secondary)">
						<Icon icon={FolderGit2} size={11} className="shrink-0 text-(--icon-tertiary)" />
						<span className="truncate">{repo.repoFullName.split('/').pop()}</span>
					</span>
				))}
				{extra > 0 ? <span className="in-num inline-flex h-[22px] items-center rounded-full bg-(--alpha-white-4) px-2 text-small text-(--text-tertiary)">+{extra}</span> : null}
				{space.repos.length === 0 ? (
					<span className="inline-flex h-[22px] items-center gap-1 rounded-full bg-(--alpha-white-4) pr-2 pl-1.5 text-small text-(--text-tertiary)">
						<Icon icon={MessageSquare} size={11} className="shrink-0" />
						Chats, no repository
					</span>
				) : null}
			</div>
			<div className="mt-3 flex flex-col px-2" style={{ minHeight: CARD_ROWS * 28 }}>
				{open.length ? (
					open.slice(0, CARD_ROWS).map((thread) => (
						<div key={thread.id} className="flex h-7 items-center gap-2 px-2">
							<ThreadStateIcon thread={thread} size={12} />
							<span className="min-w-0 flex-1 truncate text-body text-(--text-secondary)">{thread.title}</span>
							<span className="in-num shrink-0 text-micro text-(--text-disabled)">{age(threadActiveAt(thread))}</span>
						</div>
					))
				) : (
					<div className="flex flex-1 items-center justify-center gap-2 text-small text-(--text-disabled)" style={{ minHeight: CARD_ROWS * 28 }}>
						<Icon icon={Moon} size={13} />
						All quiet, no open threads
					</div>
				)}
			</div>
			<footer className="mt-auto flex items-center gap-3 border-t border-(--border-subtle) px-4 py-2.5">
				<ActivityBars bars={activity(threads, now, 14).bars} height={14} className="w-[64px] shrink-0" />
				<span className="min-w-0 flex-1 truncate text-small text-(--text-tertiary)">
					{space.threads} thread{space.threads === 1 ? '' : 's'} · {age(space.activeAt) === 'now' ? 'active now' : `active ${age(space.activeAt)} ago`}
				</span>
				<Icon icon={ArrowRight} size={13} className="shrink-0 text-(--icon-tertiary) transition-transform duration-(--duration-standard) group-hover/card:translate-x-0.5 group-hover/card:text-(--icon-primary)" />
			</footer>
		</Link>
	);
}

/** The projects at a glance, over the cards: how many, what needs you, what works, what is open. */
function Summary({ spaces }: { spaces: Space[] }) {
	const sum = (pick: (space: Space) => number) => spaces.reduce((total, space) => total + pick(space), 0);
	const waiting = sum((space) => space.counts.waiting);
	const working = sum((space) => space.counts.working);
	const open = sum((space) => space.counts.waiting + space.counts.working + space.counts.queued + space.counts.review + space.counts.landing + space.counts.idle);
	const items: Array<[string, number, string?]> = [
		['projects', spaces.length],
		['open threads', open],
		['working', working, 'text-(--accent-text)'],
		['need you', waiting, 'text-(--attention-text)'],
	];
	return (
		<div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
			{items.map(([label, value, tone]) => (
				<span key={label} className="inline-flex items-baseline gap-1.5">
					<span className={cn('in-figure text-h2 leading-6', value > 0 && tone)}>{value}</span>
					<span className="text-small text-(--text-tertiary)">{label}</span>
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
				<Dialog.Content aria-describedby={undefined} onCloseAutoFocus={(event) => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }} className="in-card fixed top-[10vh] left-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 flex-col overflow-hidden shadow-(--shadow-modal)">
			<form
				className="flex min-h-0 flex-col"
				onSubmit={(event) => {
					event.preventDefault();
					create.mutate();
				}}
			>
				<header className="flex items-center gap-2 border-b border-(--border-subtle) px-4 py-3">
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
											'flex h-9 items-center gap-2.5 rounded-tile border px-2.5 text-left text-body outline-none focus-visible:shadow-(--focus-ring)',
											on ? 'border-(--accent-border) bg-(--accent-bg-subtle) text-(--text-primary)' : 'border-(--border-subtle) bg-(--well-bg) text-(--text-secondary) hover:border-(--border-default)',
										)}
									>
										<Icon icon={FolderGit2} size={13} className={on ? 'text-(--accent-text)' : 'text-(--icon-tertiary)'} />
										<span className="min-w-0 flex-1 truncate">{project.repoFullName}</span>
										{on ? <Icon icon={Check} size={13} className="text-(--accent-text)" /> : null}
									</button>
								);
							})}
							{projects.data && projects.data.projects.length === 0 ? (
								<span className="text-small text-(--text-tertiary)">
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
				<footer className="flex items-center gap-2 border-t border-(--border-subtle) px-4 py-2.5">
					{create.isError ? <span className="min-w-0 flex-1 text-small text-(--danger-text)">{create.error.message}</span> : <span className="flex-1" />}
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
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: SAFETY_NET_MS });
	const [creating, setCreating] = useState(Boolean(search.create));
	useEffect(() => {
		if (search.create) {
			setCreating(true);
			void navigate({ to: '/projects', search: {}, replace: true });
		}
	}, [search.create]);
	const list = [...(spaces.data?.spaces ?? [])].sort((a, b) => Number(a.state === 'archived') - Number(b.state === 'archived') || b.counts.waiting - a.counts.waiting || b.activeAt.localeCompare(a.activeAt));
	const active = list.filter((space) => space.state !== 'archived');
	return (
		<PageFrame
			title="Projects"
			actions={
				<Btn size="sm" icon={Plus} onClick={() => setCreating(true)}>
					New project
				</Btn>
			}
		>
			{spaces.isPending ? <Spinner size={12} /> : null}
			{spaces.isError ? <div role="alert" className="in-card flex flex-wrap items-center gap-3 p-4 text-body text-(--text-secondary)">Unable to load projects. Check your connection and try again. <Btn size="sm" onClick={() => void spaces.refetch()}>Try again</Btn></div> : null}
			{spaces.data && list.length === 0 ? (
				<div className="in-card p-1.5">
					<EmptyState
						art={<ProjectArt className="w-full max-w-[360px]" />}
						title="Run several threads at once"
						body="A project groups work under one goal, with or without repositories. Its coordinator splits the work into threads that run in parallel, each in its own sandbox, and tells you which need you."
					>
						<Btn size="sm" variant="primary" icon={Plus} onClick={() => setCreating(true)}>
							New project
						</Btn>
					</EmptyState>
				</div>
			) : null}
			{active.length > 0 ? <Summary spaces={active} /> : null}
			{list.length ? (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{list.map((space) => (
						<ProjectCard key={space.id} space={space} />
					))}
					<button
						type="button"
						onClick={() => setCreating(true)}
						className="group/new flex min-h-[220px] flex-col items-center justify-center gap-2.5 rounded-card border border-dashed border-(--border-default) px-6 text-center outline-none hover:border-(--accent-border) hover:bg-(--accent-bg-subtle) focus-visible:shadow-(--focus-ring)"
					>
						<span className="inline-flex size-9 items-center justify-center rounded-full bg-(--alpha-white-6) text-(--icon-secondary) group-hover/new:bg-(--accent-bg-subtle) group-hover/new:text-(--accent-text)">
							<Icon icon={Plus} size={16} />
						</span>
						<span className="text-body font-medium text-(--text-secondary) group-hover/new:text-(--text-primary)">New project</span>
						<span className="max-w-[220px] text-small leading-4 text-(--text-disabled)">A goal, its repositories, and a coordinator that runs threads in parallel.</span>
					</button>
				</div>
			) : null}
			{active.length > 0 && sessions.data ? <ProjectRack spaces={active} threads={sessions.data.sessions} /> : null}
			{active.length > 0 && sessions.isError ? <div role="alert" className="in-card flex flex-wrap items-center gap-3 p-4 text-body text-(--text-secondary)">Unable to load thread activity. Check your connection and try again. <Btn size="sm" onClick={() => void sessions.refetch()}>Try again</Btn></div> : null}
			{creating ? <NewProjectDialog onClose={() => setCreating(false)} /> : null}
		</PageFrame>
	);
}
