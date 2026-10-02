import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, Folder, GitBranch, Play, Plus } from 'lucide-react';
import { useState } from 'react';
import { ModelPicker, useModels } from '@/components/model-picker';
import { MenuButton } from '@/components/nav';
import {
	Btn,
	Icon,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	MenuTrigger,
	PickerChip,
	SectionLabel,
	Spinner,
} from '@/components/signal';
import { api, type ModelChoice, type Project, type Session } from '@/lib/api';
import { age } from '@/lib/format';
import { useCreateChat } from '@/lib/create-chat';
import { chooseProject, useProjects } from '@/lib/projects';

function StatusIcon({ session }: { session: Session }) {
	if (session.status === 'running' || session.status === 'starting') return <Spinner />;
	if (session.status === 'error') return <Icon icon={CircleAlert} className="text-(--danger-text)" />;
	return <Icon icon={CircleCheck} className="text-(--success-text)" />;
}

function RepoPicker({ projects, value, onChange, onAdd }: { projects: Project[]; value?: Project; onChange: (id: string) => void; onAdd: () => void }) {
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

/** Adds a GitHub repo by name; Anton's token must be able to read it. */
function AddRepo({ onAdded, onCancel }: { onAdded: (project: Project) => void; onCancel: () => void }) {
	const [name, setName] = useState('');
	const queryClient = useQueryClient();
	const add = useMutation({
		mutationFn: () => api.addProject(name.trim()),
		onSuccess: (project) => {
			void queryClient.invalidateQueries({ queryKey: ['projects'] });
			onAdded(project);
		},
	});
	return (
		<form
			className="flex flex-col gap-1.5"
			onSubmit={(event) => {
				event.preventDefault();
				if (name.trim()) add.mutate();
			}}
		>
			<div className="flex items-center gap-1.5">
				<input
					autoFocus
					value={name}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => event.key === 'Escape' && onCancel()}
					placeholder="owner/repository"
					className="h-7 min-w-0 flex-1 rounded-lg bg-(--bg-surface) px-2.5 text-[13px] text-(--text-primary) outline-none focus-visible:shadow-(--focus-ring)"
				/>
				<Btn type="submit" size="sm" disabled={add.isPending || !name.trim()}>
					{add.isPending ? 'Adding…' : 'Add'}
				</Btn>
				<Btn size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Btn>
			</div>
			{add.isError ? <p className="m-0 text-[12px] text-(--danger-text)">{add.error.message}</p> : null}
		</form>
	);
}

export function Launcher() {
	const [prompt, setPrompt] = useState('');
	const [choice, setChoice] = useState<Partial<ModelChoice>>({});
	const [projectId, setProjectId] = useState('');
	const [branch, setBranch] = useState('');
	const [adding, setAdding] = useState(false);
	const create = useCreateChat();
	const models = useModels();
	const projects = useProjects();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
	const project = chooseProject(projects.data?.projects ?? [], projectId);
	const model = choice.model ?? models.data?.default ?? '';
	const chosenBranch = branch || project?.defaultBranch || '';
	const recent = (sessions.data?.sessions ?? []).slice(0, 6);

	function pick(id: string) {
		setProjectId(id);
		setBranch('');
	}

	function start() {
		if (create.isPending || !project) return;
		create.mutate({
			prompt,
			projectId: project.id,
			branch: chosenBranch || undefined,
			model: model || undefined,
			reasoning: choice.reasoning ?? undefined,
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
						<h1 className="m-0 text-[24px] leading-[30px] font-semibold tracking-[-0.022em]">What should the agent do?</h1>
						<p className="m-0 text-[13px] leading-[19px] text-pretty text-(--text-tertiary)">
							Describe the outcome, not the steps. Anton works on its own branch in a fresh sandbox, and shows the diff, the
							terminal, and the files as it goes.
						</p>
					</div>

					<form
						className="flex flex-col gap-3 rounded-xl bg-(--bg-surface) px-4 pt-4 pb-2.5"
						onSubmit={(event) => {
							event.preventDefault();
							start();
						}}
					>
						<textarea
							autoFocus
							rows={4}
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
									event.preventDefault();
									start();
								}
							}}
							placeholder="Uploads retry forever when S3 returns 503. Add capped backoff and cover it with a test."
							className="w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-[21px] text-(--text-primary) outline-none"
						/>
						<div className="flex flex-wrap items-center gap-1.5">
							<RepoPicker projects={projects.data?.projects ?? []} value={project} onChange={pick} onAdd={() => setAdding(true)} />
							<BranchPicker project={project} value={chosenBranch} onChange={setBranch} />
							<ModelPicker
								value={{ model, reasoning: choice.reasoning ?? null }}
								onChange={(change) => setChoice((current) => ({ ...current, ...change }))}
								height={28}
								side="bottom"
							/>
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

					{recent.length > 0 ? (
						<div className="flex flex-col gap-0.5 pt-2">
							<SectionLabel className="px-2 pb-1.5">Recent tasks</SectionLabel>
							{recent.map((session) => (
								<Link
									key={session.id}
									to="/agents/$sessionId"
									params={{ sessionId: session.id }}
									search={{ app: 'code' }}
									className="flex h-11 items-center gap-2.5 rounded-lg px-2 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
								>
									<span className="inline-flex text-(--icon-tertiary)">
										<StatusIcon session={session} />
									</span>
									<div className="flex min-w-0 flex-1 flex-col gap-px">
										<div className="truncate text-[13px] text-(--text-primary)">{session.title}</div>
										<div className="truncate text-[11px] text-(--text-disabled)">
											{session.repo} · {session.branch}
										</div>
									</div>
									<div className="text-[11px] whitespace-nowrap text-(--text-tertiary)">
										{age(session.createdAt)}
										{session.status === 'error' ? ' · failed' : session.prUrl ? ' · PR opened' : ''}
									</div>
								</Link>
							))}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
