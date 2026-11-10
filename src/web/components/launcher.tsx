import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUp, BookOpen, Folder, GitBranch, GitPullRequest, Globe, ListChecks, type LucideIcon, MessageSquare, Plus, Settings, Sparkle, SquareTerminal } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import { PlanToggle } from '@/components/composer';
import { HomeDashboard, SkyCredit } from '@/components/home-dashboard';
import { ComposerPlus } from '@/components/composer-plus';
import { AttachmentTray, useAttachments } from '@/components/attachments';
import { ComposerInput } from '@/components/composer-input';
import { Mascot, useMascotMood } from '@/components/mascot';
import { ModelPicker, useModels } from '@/components/model-picker';
import { useGeneralSettings } from '@/components/settings/general';
import { MenuButton } from '@/components/nav';
import { Btn, Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, PickerChip } from '@/components/signal';
import { api, type ModelChoice, type Project, type RunOn } from '@/lib/api';
import { expandCommand } from '@/lib/completion';
import { useCreateChat } from '@/lib/create-chat';
import { useDraftWake } from '@/lib/wake';
import { chooseProject, NO_REPO, useProjects } from '@/lib/projects';
import { parseRouted } from '../../core/model-route';

/**
 * The repo a task works on, or No repository for a chat: a question, a job on
 * the web, or work in a scratch sandbox, with no branch or pull request.
 */
function RepoPicker({ projects, value, onChange, onAdd }: { projects: Project[]; value?: Project; onChange: (id: string) => void; onAdd: () => void }) {
	const navigate = useNavigate();
	return (
		<Menu>
			<MenuTrigger asChild>
				<PickerChip icon={value ? Folder : MessageSquare} label={value ? value.repoFullName.split('/').pop()! : 'No repository'} height={28} />
			</MenuTrigger>
			<MenuContent align="start" className="min-w-[240px]">
				<MenuItem icon={MessageSquare} checked={!value} onSelect={() => onChange(NO_REPO)}>
					No repository
				</MenuItem>
				{projects.length > 0 ? <MenuLabel>Repositories</MenuLabel> : null}
				{projects.map((project) => (
					<MenuItem key={project.id} checked={project.id === value?.id} onSelect={() => onChange(project.id)}>
						{project.repoFullName}
					</MenuItem>
				))}
				<MenuSeparator />
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
					className="h-7 min-w-0 flex-1 rounded-tile bg-(--bg-surface) px-2.5 text-body text-(--text-primary) outline-none focus-visible:shadow-(--focus-ring)"
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
							className="flex h-7 items-center gap-2 rounded-control px-2 text-left text-small text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
						>
							<Icon icon={Folder} size={12} className="text-(--icon-tertiary)" />
							<span className="min-w-0 flex-1 truncate">{repo}</span>
						</button>
					))}
				</div>
			) : null}
			{add.isError ? <p className="m-0 text-small text-(--danger-text)">{add.error.message}</p> : null}
		</form>
	);
}

type Stage = { title: string; note: string; icon: LucideIcon };

/**
 * How a task runs, left to right, as one quiet line under the composer: it reads
 * first, then takes its own branch, starts a sandbox only when it has to edit or
 * run code, and ends in a pull request. Each stage lights in turn.
 */
function Route({ repo, branch, planMode }: { repo?: string; branch: string; planMode: boolean }) {
	const stages: Stage[] = [
		{ title: planMode ? 'Plans' : 'Reads', note: repo ?? 'the repository', icon: planMode ? ListChecks : BookOpen },
		{ title: 'Branches', note: `off ${branch || 'main'}`, icon: GitBranch },
		{ title: 'Sandbox', note: 'when it edits', icon: SquareTerminal },
		{ title: 'Pull request', note: 'for your review', icon: GitPullRequest },
	];
	return <RouteLine label="How a task runs" stages={stages} />;
}

/** A chat's route: no repository, so it answers, browses, and runs things in a scratch sandbox only when it must. */
function ChatRoute() {
	const stages: Stage[] = [
		{ title: 'Asks', note: 'no repository', icon: MessageSquare },
		{ title: 'Browses', note: 'the web', icon: Globe },
		{ title: 'Scratch', note: 'when it runs code', icon: SquareTerminal },
		{ title: 'Answers', note: 'in the chat', icon: Sparkle },
	];
	return <RouteLine label="How a chat runs" stages={stages} />;
}

function RouteLine({ label, stages }: { label: string; stages: Stage[] }) {
	return (
		<ol aria-label={label} className="sky-credit m-0 mx-auto flex w-fit max-w-full list-none flex-wrap items-center justify-center gap-x-1 gap-y-1 rounded-card px-3 py-1.5 text-small sm:rounded-full">
			{stages.map((stage, index) => (
				<li key={stage.title} className="flex items-center gap-1">
					{index > 0 ? <span aria-hidden className="mx-1 h-px w-4 bg-(--border-strong)" /> : null}
					<span className="route-caption inline-flex items-center gap-1.5 text-(--text-tertiary)" data-first={index === 0 || undefined} style={{ '--stage': index } as CSSProperties}>
						<Icon icon={stage.icon} size={12} />
						<span>{stage.title}</span>
					</span>
					<span className="hidden text-(--text-disabled) sm:inline">{stage.note}</span>
				</li>
			))}
		</ol>
	);
}

export function Launcher() {
	const [prompt, setPrompt] = useState('');
	const [choice, setChoice] = useState<Partial<ModelChoice>>({});
	const [projectId, setProjectId] = useState('');
	const [branch, setBranch] = useState('');
	const [planChoice, setPlanMode] = useState<boolean | null>(null);
	const [runOn, setRunOn] = useState<RunOn>('sandbox');
	const [adding, setAdding] = useState(false);
	const attachments = useAttachments();
	const queryClient = useQueryClient();
	const create = useCreateChat();
	const [starting, setStarting] = useState(false);
	const mood = useMascotMood({ busy: starting, waiting: false, stir: prompt });
	const models = useModels();
	const projects = useProjects();
	const project = chooseProject(projects.data?.projects ?? [], projectId);
	const general = useGeneralSettings();
	const specifier = choice.model ?? models.data?.default ?? '';
	const { model, route } = parseRouted(specifier);
	// Picking a model sets its reasoning to null, so the default level only rides with the default model.
	const reasoning = choice.reasoning !== undefined ? choice.reasoning : (general.data?.reasoning ?? null);
	// No repository picked (or none added yet): the task is a chat, with no branch to pick or plan to make.
	const chat = projects.isSuccess && !project;
	const planMode = !chat && (planChoice ?? general.data?.planMode ?? false);
	const chosenBranch = branch || project?.defaultBranch || '';
	// A task that will edit code gets its sandbox started as you type, so it is ready when you start the task.
	const takeTaskId = useDraftWake({ projectId: project?.id, branch: chosenBranch, typed: prompt.trim().length > 0, enabled: !chat && !planMode && runOn === 'sandbox' });
	const chosenModel = models.data?.models.find((item) => item.id === model);
	const blind = attachments.images.length > 0 && chosenModel !== undefined && !chosenModel.vision;

	function chooseModel(change: Partial<ModelChoice>) {
		setChoice((current) => ({ ...current, ...change }));
	}

	function pick(id: string) {
		setProjectId(id);
		setBranch('');
	}

	async function start() {
		if (starting || !projects.isSuccess) return;
		setStarting(true);
		// Saved commands are read only for a prompt that starts with one, so any other opens its task without a round trip.
		const saved = prompt.trim().startsWith('/') ? await queryClient.fetchQuery({ queryKey: ['commands'], queryFn: api.commands, staleTime: 60_000 }).catch(() => ({ commands: [] })) : { commands: [] };
		const { images, files } = attachments;
		// The task opens at once; it is made behind its page.
		create({
			id: takeTaskId(),
			prompt: expandCommand(prompt, saved.commands, true),
			images,
			files,
			projectId: project?.id,
			repo: project?.repoFullName,
			branch: project ? chosenBranch || undefined : undefined,
			model: model || undefined,
			reasoning: reasoning ?? undefined,
			route,
			planMode,
			runOn,
		});
	}

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-1 pr-4 pl-2 md:hidden">
				<MenuButton />
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-16 md:px-6">
				<div className="mx-auto flex max-w-[880px] flex-col gap-10 pt-6 md:pt-[min(16vh,148px)]">
					<div className="mx-auto flex w-full max-w-[680px] flex-col gap-4">
						{/* The sidebar already names the product; Home asks the one question it is for. */}
						<h1 className="m-0 text-h2 leading-7 font-medium tracking-[-0.02em] text-(--text-primary)">{chat ? 'What should Anton look into?' : 'What should Anton work on?'}</h1>

						<form
							className="home-composer relative flex flex-col"
							onSubmit={(event) => {
								event.preventDefault();
								void start();
							}}
							{...attachments.dropZone}
						>
							<Mascot mood={mood} className="absolute right-6 bottom-[calc(100%-1px)]" />
							<AttachmentTray attachments={attachments} className="px-4 pt-3.5" />
							<ComposerInput
								autoFocus
								value={prompt}
								onChange={setPrompt}
								projectId={project?.id}
								branch={chosenBranch}
								submitOn="mod-enter"
								suggestionsPosition="below"
								onPaste={attachments.onPaste}
								placeholder={chat ? 'Ask anything, or hand off a job on the web' : 'Ask Anton to build a feature, fix a bug, or explain the code'}
								className="min-h-[84px] px-4 pt-3.5 text-body-lg leading-[21px]"
							/>
							{attachments.notice || blind ? (
								<div className="px-4 pt-2 text-small text-(--warning-text)">
									{blind ? `${chosenModel?.name ?? 'This model'} cannot see images. Pick a model marked Vision to send them.` : attachments.notice}
								</div>
							) : null}
							<div className="mt-2 flex flex-wrap items-center gap-1 px-2.5 pt-1 pb-2.5">
								<ComposerPlus attachments={attachments} side="bottom" run={{ value: runOn, onChange: setRunOn }} />
								<RepoPicker projects={projects.data?.projects ?? []} value={project} onChange={pick} onAdd={() => setAdding(true)} />
								{chat ? null : <BranchPicker project={project} value={chosenBranch} onChange={setBranch} />}
								<ModelPicker value={{ model: specifier, reasoning }} onChange={chooseModel} height={28} side="bottom" />
								{chat ? null : <PlanToggle on={planMode} onChange={setPlanMode} />}
								<div className="min-w-0 flex-[1_1_8px]" />
								<button
									type="submit"
									aria-label={chat ? 'Start chat' : 'Start task'}
									title={chat ? 'Start chat (⌘↵)' : 'Start task (⌘↵)'}
									disabled={starting || !projects.isSuccess || blind}
									className="sg-btn sg-btn--primary sg-icon-btn sg-btn--round size-8"
								>
									<Icon icon={ArrowUp} size={16} />
								</button>
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
						{chat ? <ChatRoute /> : <Route repo={project?.repoFullName} branch={chosenBranch} planMode={planMode} />}
					</div>

					<HomeDashboard />
					<div className="-mt-2 flex min-w-0 justify-end">
						<SkyCredit />
					</div>
				</div>
			</div>
		</div>
	);
}
