import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Folder, Plus } from 'lucide-react';
import { useState } from 'react';
import { AddRepo } from '@/components/launcher';
import { Btn, EmptyState, Icon, Spinner } from '@/components/signal';
import { api, type Project, type Session } from '@/lib/api';
import { age } from '@/lib/format';
import { useProjects } from '@/lib/projects';
import { List, PageHeading, RowIcon } from './parts';

function detail(project: Project, sessions: Session[]): string {
	const tasks = sessions.filter((session) => session.projectId === project.id).length;
	const image = project.warmedAt ? `prepared image ${age(project.warmedAt)} old` : 'no prepared image yet';
	return `Default branch ${project.defaultBranch} · ${tasks} ${tasks === 1 ? 'task' : 'tasks'} · ${image}`;
}

function RepoRow({ project, sessions }: { project: Project; sessions: Session[] }) {
	return (
		<Link
			to="/settings/repos/$projectId"
			params={{ projectId: project.id }}
			className="flex min-h-14 items-center gap-3 rounded-[10px] px-2.5 py-2 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
		>
			<RowIcon icon={Folder} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="truncate text-[13px] font-medium">{project.repoFullName}</div>
				<div className="truncate text-[12px] text-(--text-tertiary)">{detail(project, sessions)}</div>
			</div>
			<span className="hidden h-[22px] shrink-0 items-center rounded-full border border-(--border-subtle) px-2 font-mono text-[11px] text-(--text-tertiary) sm:inline-flex">{project.baseImage ?? 'default image'}</span>
			<Icon icon={ChevronRight} size={12} className="text-(--icon-disabled)" />
		</Link>
	);
}

/** Every repository tasks can work on, each opening its own settings. */
export function RepositoriesPage() {
	const projects = useProjects();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const [adding, setAdding] = useState(false);
	const list = projects.data?.projects ?? [];
	return (
		<>
			<PageHeading
				title="Repositories"
				actions={
					<Btn size="sm" icon={Plus} onClick={() => setAdding(true)}>
						Add
					</Btn>
				}
			>
				Tasks only work on repositories added here, through Anton's GitHub token. Each one has its own variables, setup script, preview ports,
				memory and automations.
			</PageHeading>
			{adding ? <AddRepo onAdded={() => setAdding(false)} onCancel={() => setAdding(false)} /> : null}
			{projects.isPending ? (
				<Spinner size={12} />
			) : list.length === 0 ? (
				<EmptyState icon={Folder} title="No repositories yet" body="Add one from your GitHub repositories to start a task on it." />
			) : (
				<List>
					{list.map((project) => (
						<RepoRow key={project.id} project={project} sessions={sessions.data?.sessions ?? []} />
					))}
				</List>
			)}
		</>
	);
}
