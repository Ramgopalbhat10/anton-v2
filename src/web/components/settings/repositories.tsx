import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Folder, GitBranch, Plus } from 'lucide-react';
import { useState } from 'react';
import { Caption, Chip } from '@/components/instrument';
import { AddRepo } from '@/components/launcher';
import { Btn, EmptyState, Icon, Spinner } from '@/components/signal';
import { api, type Project, type Session } from '@/lib/api';
import { age } from '@/lib/format';
import { useProjects } from '@/lib/projects';
import { List, PageHeading, RowIcon } from './parts';

function RepoRow({ project, sessions }: { project: Project; sessions: Session[] }) {
	const tasks = sessions.filter((session) => session.projectId === project.id).length;
	const slash = project.repoFullName.indexOf('/') + 1;
	const [owner, name] = [project.repoFullName.slice(0, slash), project.repoFullName.slice(slash)];
	return (
		<Link
			to="/settings/repos/$projectId"
			params={{ projectId: project.id }}
			className="flex min-h-14 items-center gap-3 rounded-[10px] px-2.5 py-2 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
		>
			<RowIcon icon={Folder} />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="truncate text-[13px] font-medium">
					<span className="font-normal text-(--text-tertiary)">{owner}</span>
					{name}
				</div>
				<div className="flex min-w-0 items-center gap-1 text-(--text-tertiary)" title={`Default branch ${project.defaultBranch}`}>
					<Icon icon={GitBranch} size={11} className="shrink-0" />
					<span className="in-num truncate text-[11.5px]">{project.defaultBranch}</span>
				</div>
			</div>
			<div className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
				<span className="in-num text-[13px] text-(--text-primary)">{tasks}</span>
				<Caption>{tasks === 1 ? 'task' : 'tasks'}</Caption>
			</div>
			<div className="hidden w-[150px] shrink-0 flex-col items-end gap-1 md:flex">
				{project.warmedAt ? (
					<Chip tone="success" title="A prepared image starts its sandboxes with the repository and setup already in place">
						image · {age(project.warmedAt)} old
					</Chip>
				) : (
					<Chip className="border-dashed bg-transparent text-(--text-tertiary)" title="Sandboxes clone and set up the repository each time until an image is prepared">
						no prepared image
					</Chip>
				)}
				<Chip mono title="The base image its sandboxes start from">
					{project.baseImage ?? 'default image'}
				</Chip>
			</div>
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
				info="Tasks only work on repositories added here, through Anton's GitHub token. Each has its own variables, setup script, preview ports, memory and automations."
				actions={
					<Btn size="sm" icon={Plus} onClick={() => setAdding(true)}>
						Add
					</Btn>
				}
			>
				What tasks can work on, each with its own settings.
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
