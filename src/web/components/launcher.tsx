import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Clock, Folder, GitBranch, Play, Plus, Settings } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import { PlanToggle } from '@/components/composer';
import { TaskRouteArt } from '@/components/illustrations';
import { Caption, Card } from '@/components/instrument';
import { ComposerInput } from '@/components/composer-input';
import { ModelPicker, useModels } from '@/components/model-picker';
import { useGeneralSettings } from '@/components/settings/general';
import { MenuButton } from '@/components/nav';
import { Btn, Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, PickerChip } from '@/components/signal';
import { TaskStatusIcon } from '@/components/task-status';
import { api, branchLabel, type ModelChoice, type Project } from '@/lib/api';
import { expandCommand } from '@/lib/completion';
import { age } from '@/lib/format';
import { useCreateChat } from '@/lib/create-chat';
import { chooseProject, useProjects } from '@/lib/projects';

function RepoPicker({ projects, value, onChange, onAdd }: { projects: Project[]; value?: Project; onChange: (id: string) => void; onAdd: () => void }) {
	const navigate = useNavigate();
	return (
		<Menu>
			<MenuTrigger asChild>
				<PickerChip icon={Folder} label={value ? value.repoFullName.split('/').pop()! : 'Choose a repo'} height={28} />
			</MenuTrigger>
			<MenuContent align="start" className="min-w-[220px]">
				{projects.map((project) => (
					<MenuItem key={project.id} checked={project.id === value?.id} onSelect={() => onChange(project.id)}>
						{project.repoFullName}
					</MenuItem>
				))}
				{projects.length > 0 ? <MenuSeparator /> : null}
				<MenuItem icon={Plus} onSelect={onAdd}>
					Add a repository
				</MenuItem>
				{value ? (
					<MenuItem icon={Settings} onSelect={() => void navigate({ to: '/settings/repos/$projectId', params: { projectId: value.id } })}>
						Repository settings
					</MenuItem>
				) : null}
			</MenuContent>
		</Menu>
	);
}

function BranchPicker({ project, value, onChange }: { project?: Project; value: string; onChange: (branch: string) => void }) {
	const branches = useQuery({
		queryKey: ['branches', project?.id],
		queryFn: () => api.branches(project!.id),
		enabled: Boolean(project),
	});
	return (
		<Menu>
			<MenuTrigger asChild>
				<PickerChip icon={GitBranch} label={value || 'main'} height={28} disabled={!project} />
			</MenuTrigger>
			<MenuContent align="start" className="max-h-[320px] min-w-[200px] overflow-y-auto">
				{branches.isPending ? <MenuLabel>Loading branches</MenuLabel> : null}
				{branches.isError ? <MenuLabel>Could not list branches</MenuLabel> : null}
				{(branches.data?.branches ?? []).map((branch) => (
					<MenuItem key={branch} checked={branch === value} onSelect={() => onChange(branch)}>
						{branch}
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}

/** Repos offered at once; typing narrows them. */
const REPOS_SHOWN = 8;

/** Adds a GitHub repo, picked from those Anton's token can reach or typed by name. */
export function AddRepo({ onAdded, onCancel }: { onAdded: (project: Project) => void; onCancel: () => void }) {
	const [name, setName] = useState('');
	const queryClient = useQueryClient();
	const reachable = useQuery({ queryKey: ['addable-repos'], queryFn: api.addableRepos, staleTime: 60_000 });
	const add = useMutation({
		mutationFn: (repo: string) => api.addProject(repo),
		onSuccess: (project) => {
			void queryClient.invalidateQueries({ queryKey: ['projects'] });
			void queryClient.invalidateQueries({ queryKey: ['addable-repos'] });
			onAdded(project);
		},
	});
	const query = name.trim().toLowerCase();
	const matches = (reachable.data?.repos ?? []).filter((repo) => repo.toLowerCase().includes(query)).slice(0, REPOS_SHOWN);
	return (
		<form
			className="flex flex-col gap-1.5"
			onSubmit={(event) => {
				event.preventDefault();
				if (name.trim()) add.mutate(name.trim());
			}}
		>
			<div className="flex items-center gap-1.5">
				<input
					autoFocus
					value={name}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => event.key === 'Escape' && onCancel()}
					placeholder="Search your repositories, or type owner/repository"
					aria-label="Repository"
					className="h-7 min-w-0 flex-1 rounded-lg bg-(--bg-surface) px-2.5 text-[13px] text-(--text-primary) outline-none focus-visible:shadow-(--focus-ring)"
				/>
				<Btn type="submit" size="sm" disabled={add.isPending || !name.trim()}>
					{add.isPending ? 'Adding…' : 'Add'}
				</Btn>
				<Btn size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Btn>
			</div>
			{matches.length > 0 ? (
				<div className="flex flex-col gap-px" role="list" aria-label="Your repositories">
					{matches.map((repo) => (
						<button
							type="button"
							key={repo}
							disabled={add.isPending}
							onClick={() => add.mutate(repo)}
							className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-[12px] text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
						>
							<Icon icon={Folder} size={12} className="text-(--icon-tertiary)" />
							<span className="min-w-0 flex-1 truncate">{repo}</span>
						</button>
					))}
				</div>
			) : null}
			{add.isError ? <p className="m-0 text-[12px] text-(--danger-text)">{add.error.message}</p> : null}
		</form>
	);
}

type Stage = { title: string; note: string };

/**
 * How a task runs, left to right: it reads first, then takes its own branch,
 * starts a sandbox only when it has to edit or run code, and ends in a pull request.
 * The drawing shows the line and lights each stage in turn; the captions under
 * it are the words, and light with their stage.
 */
function Route({ repo, branch, planMode }: { repo?: string; branch: string; planMode: boolean }) {
	const stages: Stage[] = [
		{ title: planMode ? 'Plan' : 'Read', note: repo ?? 'repository' },
		{ title: 'Branch', note: `off ${branch || 'main'}` },
		{ title: 'Sandbox', note: 'when it edits' },
		{ title: 'Pull request', note: 'for your review' },
	];
	return (
		<div className="in-well in-grid flex flex-col gap-2 px-3 pt-6 pb-4 sm:px-4">
			<TaskRouteArt className="w-full" />
			<ol aria-label="How a task runs" className="m-0 grid list-none grid-cols-4 p-0">
				{stages.map((stage, index) => (
					<li key={stage.title} className="flex min-w-0 flex-col items-center gap-0.5 px-1 text-center">
						<span className="in-caption route-caption text-(--text-tertiary)" data-first={index === 0 || undefined} style={{ '--stage': index } as CSSProperties}>
							{String(index + 1).padStart(2, '0')} {stage.title}
						</span>
						<div className="w-full truncate text-[12px] text-(--text-secondary)">{stage.note}</div>
					</li>
				))}
			</ol>
		</div>
	);
}

export function Launcher() {
	const [prompt, setPrompt] = useState('');
	const [choice, setChoice] = useState<Partial<ModelChoice>>({});
	const [projectId, setProjectId] = useState('');
	const [branch, setBranch] = useState('');
	const [planChoice, setPlanMode] = useState<boolean | null>(null);
	const [adding, setAdding] = useState(false);
	const queryClient = useQueryClient();
	const create = useCreateChat();
	const models = useModels();
	const projects = useProjects();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const project = chooseProject(projects.data?.projects ?? [], projectId);
	const general = useGeneralSettings();
	const model = choice.model ?? models.data?.default ?? '';
	// Picking a model sets its reasoning to null, so the default level only rides with the default model.
	const reasoning = choice.reasoning !== undefined ? choice.reasoning : (general.data?.reasoning ?? null);
	const planMode = planChoice ?? general.data?.planMode ?? false;
	const chosenBranch = branch || project?.defaultBranch || '';
	const recent = (sessions.data?.sessions ?? []).slice(0, 6);

	function pick(id: string) {
		setProjectId(id);
		setBranch('');
	}

	async function start() {
		if (create.isPending || !project) return;
		const saved = await queryClient.fetchQuery({ queryKey: ['commands'], queryFn: api.commands, staleTime: 60_000 }).catch(() => ({ commands: [] }));
		create.mutate({
			prompt: expandCommand(prompt, saved.commands, true),
			projectId: project.id,
			branch: chosenBranch || undefined,
			model: model || undefined,
			reasoning: reasoning ?? undefined,
			planMode,
		});
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-1 border-b border-(--border-subtle) pr-4 pl-2 text-[13px] font-medium text-(--text-secondary) md:pl-4">
				<MenuButton />
				New task
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-8 pb-12 md:px-6">
				<div className="mx-auto flex max-w-[660px] flex-col gap-5">
					<div className="flex flex-col gap-2">
						<Caption>New task</Caption>
						<h1 className="m-0 text-[26px] leading-[32px] font-semibold tracking-[-0.022em]">What should the agent do?</h1>
						<p className="m-0 text-[13px] leading-[19px] text-pretty text-(--text-tertiary)">
							Describe the outcome, not the steps. Anton works on its own branch in a fresh sandbox, and shows the diff, the terminal, and the files as it goes.
						</p>
					</div>

					<form
						className="in-card relative flex flex-col focus-within:border-(--border-strong)"
						onSubmit={(event) => {
							event.preventDefault();
							void start();
						}}
					>
						<ComposerInput
							autoFocus
							value={prompt}
							onChange={setPrompt}
							projectId={project?.id}
							branch={chosenBranch}
							submitOn="mod-enter"
							suggestionsPosition="below"
							placeholder="Uploads retry forever when S3 returns 503. Add capped backoff and cover it with a test."
							className="min-h-[96px] px-4 pt-4 text-[14px] leading-[21px]"
						/>
						<div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-(--border-subtle) px-3 py-2.5">
							<RepoPicker projects={projects.data?.projects ?? []} value={project} onChange={pick} onAdd={() => setAdding(true)} />
							<BranchPicker project={project} value={chosenBranch} onChange={setBranch} />
							<ModelPicker value={{ model, reasoning }} onChange={(change) => setChoice((current) => ({ ...current, ...change }))} height={28} side="bottom" />
							<PlanToggle on={planMode} onChange={setPlanMode} />
							<div className="min-w-0 flex-[1_1_8px]" />
							<Btn type="submit" variant="primary" icon={Play} disabled={create.isPending || !project}>
								{create.isPending ? 'Starting…' : 'Start task'}
							</Btn>
						</div>
					</form>
					{adding ? (
						<AddRepo
							onAdded={(added) => {
								pick(added.id);
								setAdding(false);
							}}
							onCancel={() => setAdding(false)}
						/>
					) : null}
					{create.isError ? <p className="m-0 text-[12px] text-(--danger-text)">Could not start the task: {create.error.message}</p> : null}
					<Route repo={project?.repoFullName} branch={chosenBranch} planMode={planMode} />

					{recent.length > 0 ? (
						<Card icon={Clock} title="Recent tasks" sub={`latest ${recent.length}`}>
							<div className="flex flex-col gap-px px-1.5 pb-1.5">
								{recent.map((session) => (
									<Link
										key={session.id}
										to="/agents/$sessionId"
										params={{ sessionId: session.id }}
										search={{ app: 'code' }}
										className="flex h-12 items-center gap-3 rounded-[10px] px-2.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
									>
										<span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-(--border-subtle) bg-(--well-bg) text-(--icon-tertiary)">
											<TaskStatusIcon session={session} />
										</span>
										<div className="flex min-w-0 flex-1 flex-col gap-px">
											<div className="truncate text-[13px] text-(--text-primary)">{session.title}</div>
											<div className="truncate font-mono text-[11px] text-(--text-disabled)">
												{session.repo} · {branchLabel(session)}
											</div>
										</div>
										<div className="text-[11px] whitespace-nowrap text-(--text-tertiary)">
											{age(session.createdAt)}
											{session.status === 'error' ? ' · failed' : session.prUrl ? ' · PR opened' : ''}
										</div>
									</Link>
								))}
							</div>
						</Card>
					) : null}
				</div>
			</div>
		</div>
	);
}
