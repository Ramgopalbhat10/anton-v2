import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, FolderGit2, FolderKanban, Plus, Waypoints, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ProjectArt } from '@/components/illustrations';
import { Caption, StatRow } from '@/components/instrument';
import { PageFrame } from '@/components/page-frame';
import { SpaceMark } from '@/components/project-sidebar';
import { AREA } from '@/components/repo-settings';
import { FIELD } from '@/components/settings/parts';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { ThreadStateIcon } from '@/components/thread-card';
import { api, type Space } from '@/lib/api';
import { age } from '@/lib/format';
import { useProjects } from '@/lib/projects';
import { stateOf, useSpaces, useThreads } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/** A project as a card: its mark and goal, its repositories, what needs you and what runs, and its latest threads. */
function ProjectCard({ space }: { space: Space }) {
	const { threads } = useThreads(space.id);
	const open = threads.filter((thread) => stateOf(thread) !== 'resolved').slice(0, 3);
	const counts = space.counts;
	return (
		<Link
			to="/projects/$spaceId"
			params={{ spaceId: space.id }}
			className={cn(
				'in-card flex min-w-0 flex-col outline-none transition-colors duration-(--duration-micro) hover:border-(--border-strong) focus-visible:shadow-(--focus-ring)',
				counts.waiting > 0 && 'border-(--warning-border)',
			)}
		>
			<div className="flex items-start gap-3 px-4 pt-3.5">
				<SpaceMark space={space} size={32} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-[14px] font-medium text-(--text-primary)">{space.name}</span>
						{space.state !== 'active' ? <Caption tone="warning">{space.state}</Caption> : null}
					</div>
					<span className="line-clamp-2 min-h-[34px] text-[12px] leading-[17px] text-(--text-tertiary)">{space.goal || 'No goal yet. Tell the coordinator what this project is for.'}</span>
				</div>
			</div>
			<div className="flex flex-wrap gap-1 px-4 pt-2.5">
				{space.repos.map((repo) => (
					<span key={repo.id} className="flex h-5 items-center gap-1 rounded-[6px] border border-(--border-subtle) bg-(--well-bg) px-1.5 font-mono text-[10.5px] text-(--text-secondary)">
						<Icon icon={FolderGit2} size={10} className="text-(--icon-tertiary)" />
						{repo.repoFullName.split('/').pop()}
					</span>
				))}
			</div>
			<div className="px-4 pt-3">
				<StatRow
					stats={[
						{ label: 'needs you', value: counts.waiting, tone: counts.waiting ? 'warning' : 'neutral' },
						{ label: 'working', value: `${counts.working}/${space.maxParallel}`, tone: counts.working ? 'accent' : 'neutral' },
						{ label: 'ready', value: counts.review + counts.landing, tone: counts.review + counts.landing ? 'success' : 'neutral' },
					]}
				/>
			</div>
			<div className="mt-3 flex flex-col border-t border-(--border-subtle) px-4 py-2">
				{open.length ? (
					open.map((thread) => (
						<div key={thread.id} className="flex h-7 items-center gap-2">
							<ThreadStateIcon thread={thread} size={12} />
							<span className="min-w-0 flex-1 truncate text-[12.5px] text-(--text-secondary)">{thread.title}</span>
						</div>
					))
				) : (
					<div className="flex h-7 items-center text-[12px] text-(--text-disabled)">No open threads</div>
				)}
			</div>
			<footer className="mt-auto flex items-center gap-2 border-t border-(--border-subtle) px-4 py-2">
				<Caption className="flex-1">
					{space.threads} thread{space.threads === 1 ? '' : 's'} · active {age(space.activeAt)} ago
				</Caption>
				<Icon icon={Waypoints} size={12} className="text-(--icon-tertiary)" />
			</footer>
		</Link>
	);
}

/** Name, goal and repositories for a new project, and optionally a first message for its coordinator. */
function NewProjectDialog({ onClose }: { onClose: () => void }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const projects = useProjects();
	const [name, setName] = useState('');
	const [icon, setIcon] = useState('');
	const [goal, setGoal] = useState('');
	const [repoIds, setRepoIds] = useState<string[]>([]);
	const [ask, setAsk] = useState('');
	const create = useMutation({
		mutationFn: () => api.createSpace({ name: name.trim(), icon: icon.trim() || null, goal: goal.trim(), repoIds }),
		onSuccess: (space) => {
			void queryClient.invalidateQueries({ queryKey: ['spaces'] });
			onClose();
			void navigate({ to: '/projects/$spaceId', params: { spaceId: space.id }, search: ask.trim() ? { ask: ask.trim() } : {} });
		},
	});
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);
	const toggle = (id: string) => setRepoIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
	return (
		<div className="fixed inset-0 z-40 flex items-start justify-center bg-(--bg-scrim) px-4 pt-[10vh]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<form
				role="dialog"
				aria-label="New project"
				className="in-card flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden shadow-(--shadow-modal)"
				onSubmit={(event) => {
					event.preventDefault();
					create.mutate();
				}}
			>
				<header className="flex items-center gap-2 border-b border-(--border-subtle) px-4 py-3">
					<Icon icon={FolderKanban} size={14} className="text-(--accent-text)" />
					<span className="flex-1 text-[13.5px] font-medium">New project</span>
					<IconBtn icon={X} size="sm" label="Close" onClick={onClose} />
				</header>
				<div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3.5">
					<div className="grid grid-cols-[56px_minmax(0,1fr)] gap-2">
						<input aria-label="Icon" value={icon} maxLength={4} onChange={(event) => setIcon(event.target.value)} placeholder={name.charAt(0).toUpperCase() || '✦'} className={`${FIELD} text-center`} />
						<input autoFocus aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, like Billing v2" className={FIELD} />
					</div>
					<textarea aria-label="Goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={2} placeholder="Goal: what this project is for" className={`${AREA} text-[13px] leading-[19px]`} />
					<div className="flex flex-col gap-1.5">
						<Caption>Repositories · threads work on one each</Caption>
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
											'flex h-9 items-center gap-2.5 rounded-lg border px-2.5 text-left text-[13px] outline-none focus-visible:shadow-(--focus-ring)',
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
								<Link to="/settings/$section" params={{ section: 'repos' }} className="text-[12px] text-(--accent-text) hover:underline">
									Add a repository in Settings first
								</Link>
							) : null}
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Caption>First message to the coordinator · optional</Caption>
						<textarea value={ask} onChange={(event) => setAsk(event.target.value)} rows={3} placeholder="Split the billing rewrite into threads: the schema change, the API, and the settings page." className={`${AREA} text-[13px] leading-[19px]`} />
					</div>
				</div>
				<footer className="flex items-center gap-2 border-t border-(--border-subtle) px-4 py-2.5">
					{create.isError ? <span className="min-w-0 flex-1 text-[12px] text-(--danger-text)">{create.error.message}</span> : <span className="flex-1" />}
					<Btn size="sm" variant="ghost" onClick={onClose}>
						Cancel
					</Btn>
					<Btn type="submit" size="sm" variant="primary" icon={Plus} disabled={!name.trim() || repoIds.length === 0 || create.isPending}>
						{create.isPending ? 'Creating…' : 'Create project'}
					</Btn>
				</footer>
			</form>
		</div>
	);
}

/** Every project, waiting ones first, and the way to make a new one. */
export function ProjectsPage() {
	const search = useSearch({ from: '/projects' });
	const navigate = useNavigate();
	const spaces = useSpaces();
	const [creating, setCreating] = useState(Boolean(search.create));
	useEffect(() => {
		if (search.create) {
			setCreating(true);
			void navigate({ to: '/projects', search: {}, replace: true });
		}
	}, [search.create]);
	const list = [...(spaces.data?.spaces ?? [])].sort((a, b) => Number(a.state === 'archived') - Number(b.state === 'archived') || b.counts.waiting - a.counts.waiting || b.activeAt.localeCompare(a.activeAt));
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
			{spaces.data && list.length === 0 ? (
				<div className="in-card p-1.5">
					<EmptyState
						art={<ProjectArt className="w-full max-w-[360px]" />}
						title="Run several threads at once"
						body="A project groups repositories under one goal. Its coordinator splits the work into threads that run in parallel, each on its own branch, and tells you which need you."
					>
						<Btn size="sm" variant="primary" icon={Plus} onClick={() => setCreating(true)}>
							New project
						</Btn>
					</EmptyState>
				</div>
			) : null}
			{list.length ? (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{list.map((space) => (
						<ProjectCard key={space.id} space={space} />
					))}
					<button
						type="button"
						onClick={() => setCreating(true)}
						className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-(--border-default) text-[13px] text-(--text-tertiary) outline-none hover:border-(--accent-border) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
					>
						<Icon icon={Plus} size={16} />
						New project
					</button>
				</div>
			) : null}
			{creating ? <NewProjectDialog onClose={() => setCreating(false)} /> : null}
		</PageFrame>
	);
}
