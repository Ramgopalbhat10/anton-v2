import { unrouted } from '../../core/model-route';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { BookOpen, ChevronRight, Coins, FolderGit2, Gauge, Layers, type LucideIcon, Plus, ScrollText, Settings2, Trash2, Waypoints, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Caption, ShareRow, StatRow } from '@/components/instrument';
import { ModelPicker, useModels } from '@/components/model-picker';
import { IconPicker } from '@/components/project-icon';
import { SpaceMark } from '@/components/project-sidebar';
import { AREA } from '@/components/repo-settings';
import { Block, FIELD, HelperModel, HELPERS, PageHeading, SaveState, Select, SettingRow, SubBlock } from '@/components/settings/parts';
import { useGeneralSettings } from '@/components/settings/general';
import { Btn, EmptyState, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuTrigger, SectionLabel, Spinner } from '@/components/signal';
import { api, type Autonomy, type HelperAgent, type ModelChoice, type Space, type SpaceChange } from '@/lib/api';
import { dollars, tokens } from '@/lib/format';
import { useProjects } from '@/lib/projects';
import { closeProjectSettings, openProjectSettings, type ProjectSection } from '@/lib/project-settings-modal';
import { useSpace } from '@/lib/spaces';
import { cn } from '@/lib/utils';

const AUTONOMY: Array<{ value: Autonomy; label: string }> = [
	{ value: 'start', label: 'Starts threads on its own' },
	{ value: 'propose', label: 'Suggests threads for you to start' },
];

const PARALLEL = [1, 2, 3, 4, 5, 6, 8].map((value) => ({ value, label: `${value} at a time` }));

function useSave(space: Space) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (change: SpaceChange) => api.editSpace(space.id, change),
		onSuccess: (saved) => {
			queryClient.setQueryData(['space', space.id], saved);
			void queryClient.invalidateQueries({ queryKey: ['spaces'] });
		},
	});
}

/** Name, goal, the coordinator's and threads' models, each helper agent's, how many threads run at once, and whether the coordinator starts them. */
function General({ space }: { space: Space }) {
	const models = useModels();
	const general = useGeneralSettings();
	const save = useSave(space);
	const [name, setName] = useState(space.name);
	const [icon, setIcon] = useState<string | null>(space.icon);
	const [goal, setGoal] = useState(space.goal);
	const [coordinator, setCoordinator] = useState<ModelChoice>({ model: space.coordinatorModel ?? '', reasoning: space.coordinatorReasoning });
	const [thread, setThread] = useState<ModelChoice>({ model: space.threadModel ?? '', reasoning: space.threadReasoning });
	const [agentModels, setAgentModels] = useState<Space['agentModels']>(space.agentModels);
	const [maxParallel, setMaxParallel] = useState(space.maxParallel);
	const [autonomy, setAutonomy] = useState(space.autonomy);
	const fallback = models.data?.default ?? '';
	const nameOf = (id: string) => models.data?.models.find((model) => model.id === unrouted(id))?.name ?? unrouted(id).replace(/^openrouter\//, '');
	/** What a helper follows with its switch off: the choice in Settings › General, else the thread's own model. */
	const inherited = (agent: HelperAgent) => {
		const choice = general.data?.agentModels?.[agent];
		return general.data ? (choice ? `Default · ${nameOf(choice.model)}` : "Default · thread's model") : 'Default';
	};
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate({
					name: name.trim(),
					icon,
					goal,
					coordinatorModel: coordinator.model || null,
					coordinatorReasoning: coordinator.reasoning,
					threadModel: thread.model || null,
					threadReasoning: thread.reasoning,
					agentModels,
					maxParallel,
					autonomy,
				});
			}}
		>
			<Block
				title="Project"
				icon={Settings2}
				help="What the coordinator works toward, and how it runs threads."
				footer={
					<>
						<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} />
						<Btn type="submit" size="sm" variant="primary" disabled={save.isPending || !name.trim()}>
							{save.isPending ? 'Saving…' : 'Save'}
						</Btn>
					</>
				}
			>
				<div className="flex items-center gap-2.5">
					<IconPicker value={icon} name={name} onChange={setIcon} size={36} />
					<input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" className={`${FIELD} h-9 flex-1`} />
				</div>
				<textarea
					aria-label="Goal"
					value={goal}
					onChange={(event) => setGoal(event.target.value)}
					rows={2}
					placeholder="What this project is for: ship the billing rewrite, keep the docs current…"
					className={`${AREA} text-body leading-[19px]`}
				/>
				<SubBlock label="Models">
					<SettingRow title="Coordinator" help="Plans, starts and tracks threads." info="A small, fast model is enough; low reasoning by default.">
						<ModelPicker value={{ model: coordinator.model || fallback, reasoning: coordinator.reasoning ?? 'low' }} onChange={(change) => setCoordinator((current) => ({ ...current, ...change }))} side="bottom" />
					</SettingRow>
					<SettingRow title="Threads" help="Each thread's agent." info="Unless a thread or routine picks its own.">
						<ModelPicker value={{ model: thread.model || fallback, reasoning: thread.reasoning }} onChange={(change) => setThread((current) => ({ ...current, ...change }))} side="bottom" />
					</SettingRow>
				</SubBlock>
				<SubBlock label="Helper agents" help="Each can run on its own model for this project's threads." info="The agents that work for a thread's agent. Off, one follows Settings › General.">
					{HELPERS.map((helper) => (
						<HelperModel
							key={helper.agent}
							title={helper.title}
							help={helper.help}
							info={helper.info}
							value={agentModels[helper.agent]}
							fallback={thread.model || fallback}
							fallbackLabel={inherited(helper.agent)}
							disabled={save.isPending}
							onChange={(choice) => setAgentModels((current) => ({ ...current, [helper.agent]: choice }))}
						/>
					))}
				</SubBlock>
				<SubBlock label="Running threads">
					<div className="grid gap-3 sm:grid-cols-2">
						<Select label="At once" icon={Layers} value={maxParallel} options={PARALLEL} onChange={setMaxParallel} info="More wait as queued and start when one finishes." />
						<Select label="The coordinator" icon={Waypoints} value={autonomy} options={AUTONOMY} onChange={setAutonomy} info="Suggested threads show as cards to start with one click." />
					</div>
				</SubBlock>
			</Block>
		</form>
	);
}

/** A text the coordinator and every thread read, saved on its own. */
function TextBlock({
	space,
	field,
	title,
	icon,
	help,
	info,
	placeholder,
}: {
	space: Space;
	field: 'instructions' | 'memory';
	title: string;
	icon: typeof BookOpen;
	help: string;
	info?: string;
	placeholder: string;
}) {
	const save = useSave(space);
	const [text, setText] = useState(space[field]);
	const [base, setBase] = useState(space[field]);
	// What the coordinator remembered since the page loaded shows up, unless you are editing.
	useEffect(() => {
		if (text === base) setText(space[field]);
		setBase(space[field]);
	}, [space[field]]);
	return (
		<Block
			title={title}
			icon={icon}
			help={help}
			info={info}
			footer={
				<>
					<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} />
					<Btn size="sm" disabled={save.isPending || text === space[field]} onClick={() => save.mutate({ [field]: text })}>
						{save.isPending ? 'Saving…' : 'Save'}
					</Btn>
				</>
			}
		>
			<textarea value={text} onChange={(event) => setText(event.target.value)} rows={6} placeholder={placeholder} className={`${AREA} text-body leading-[19px]`} />
		</Block>
	);
}

/** The repositories threads can work on; with none, threads work as chats. */
function Repositories({ space }: { space: Space }) {
	const save = useSave(space);
	const projects = useProjects();
	const others = (projects.data?.projects ?? []).filter((project) => !space.repoIds.includes(project.id));
	return (
		<Block
			title="Repositories"
			icon={FolderGit2}
			help="Each thread works on one, on its own branch."
			info="Without any, threads work as chats with a scratch sandbox. Removing one keeps its threads."
			aside={
				<Menu>
					<MenuTrigger asChild>
						<Btn size="sm" variant="secondary" icon={Plus} disabled={others.length === 0 || save.isPending}>
							Add
						</Btn>
					</MenuTrigger>
					<MenuContent align="end" className="min-w-[240px]">
						{others.map((project) => (
							<MenuItem key={project.id} icon={FolderGit2} onSelect={() => save.mutate({ repoIds: [...space.repoIds, project.id] })}>
								{project.repoFullName}
							</MenuItem>
						))}
					</MenuContent>
				</Menu>
			}
		>
			<div className="flex flex-col">
				{space.repos.map((repo) => (
					<div key={repo.id} className="flex h-10 items-center gap-2.5 border-t border-(--border-subtle) first:border-t-0">
						<FolderGit2 aria-hidden size={14} strokeWidth={1.5} className="text-(--icon-tertiary)" />
						<span className="min-w-0 flex-1 truncate text-body">{repo.repoFullName}</span>
						<Caption>{repo.defaultBranch}</Caption>
						<IconBtn
							icon={X}
							size="xs"
							label={`Remove ${repo.repoFullName}`}
							disabled={save.isPending}
							onClick={() => save.mutate({ repoIds: space.repoIds.filter((id) => id !== repo.id) })}
						/>
					</div>
				))}
				{space.repos.length === 0 ? (
					<div className="flex h-10 items-center text-body text-(--text-tertiary)">
						{others.length || projects.isPending ? (
							'None. Threads work as chats until you add one.'
						) : (
							<span>
								None. Threads work as chats until you{' '}
								<Link to="/settings/$section" params={{ section: 'repos' }} className="text-(--accent-text) hover:underline">
									add a repository in Settings
								</Link>
								.
							</span>
						)}
					</div>
				) : null}
			</div>
			{save.isError ? <span className="text-small text-(--danger-text)">{save.error.message}</span> : null}
		</Block>
	);
}

/** What the project has spent: today and this month, by thread and by model. */
function Usage({ space }: { space: Space }) {
	const usage = useQuery({ queryKey: ['space-usage', space.id], queryFn: () => api.spaceUsage(space.id) });
	const data = usage.data;
	const top = Math.max(...(data?.byThread ?? []).map((row) => row.cost), 0.0001);
	const topModel = Math.max(...(data?.byModel ?? []).map((row) => row.cost), 0.0001);
	return (
		<Block title="Usage" icon={Coins} help="The coordinator and every thread, from Anton's usage log.">
			{data ? (
				<>
					<StatRow
						stats={[
							{ label: 'Today', value: dollars(data.today) },
							{ label: 'This month', value: dollars(data.month) },
							{ label: 'Threads', value: String(data.byThread.filter((row) => row.title !== 'Coordinator').length) },
						]}
					/>
					{data.byThread.length ? (
						<SubBlock label="By thread">
							{data.byThread.slice(0, 10).map((row) => (
								<ShareRow key={row.id} label={row.title} sub={`${tokens(row.tokens)} tokens`} share={row.cost / top} value={dollars(row.cost)} color={row.title === 'Coordinator' ? 'var(--accent-base)' : 'var(--neutral-500)'} />
							))}
						</SubBlock>
					) : null}
					{data.byModel.length ? (
						<SubBlock label="By model">
							{data.byModel.map((row) => (
								<ShareRow key={row.key ?? 'default'} label={row.key ?? 'Default'} sub={`${tokens(row.tokens)} tokens`} share={row.cost / topModel} value={dollars(row.cost)} />
							))}
						</SubBlock>
					) : null}
				</>
			) : (
				<Spinner size={12} />
			)}
		</Block>
	);
}

/** Pause or archive keeps everything; delete removes the project but keeps its threads as tasks. */
function Lifecycle({ space }: { space: Space }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const save = useSave(space);
	const [confirming, setConfirming] = useState(false);
	const remove = useMutation({
		mutationFn: () => api.deleteSpace(space.id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['spaces'] });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			closeProjectSettings();
			void navigate({ to: '/projects' });
		},
	});
	return (
		<Block
			title="Pause, archive or delete"
			icon={Trash2}
			className="border-(--danger-border)"
			help="Pause, archive or delete the project."
			info="Paused projects queue new threads instead of starting them. Archived ones leave the sidebar. Deleting removes the project, its coordinator conversation and its files; its threads stay as ordinary tasks."
			footer={
				<>
					{remove.isError ? <span className="text-small text-(--danger-text)">{remove.error.message}</span> : null}
					<Btn size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ state: space.state === 'paused' ? 'active' : 'paused' })}>
						{space.state === 'paused' ? 'Resume' : 'Pause'}
					</Btn>
					<Btn size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ state: space.state === 'archived' ? 'active' : 'archived' })}>
						{space.state === 'archived' ? 'Unarchive' : 'Archive'}
					</Btn>
					<Btn variant="danger" size="sm" disabled={remove.isPending} onClick={() => (confirming ? remove.mutate() : setConfirming(true))} onBlur={() => setConfirming(false)}>
						{remove.isPending ? 'Deleting…' : confirming ? 'Click again to delete' : 'Delete project'}
					</Btn>
				</>
			}
		/>
	);
}

const SECTIONS: Array<{ id: ProjectSection; label: string; icon: LucideIcon }> = [
	{ id: 'general', label: 'General', icon: Settings2 },
	{ id: 'instructions', label: 'Instructions', icon: ScrollText },
	{ id: 'memory', label: 'Memory', icon: BookOpen },
	{ id: 'repositories', label: 'Repositories', icon: FolderGit2 },
	{ id: 'usage', label: 'Usage', icon: Coins },
	{ id: 'lifecycle', label: 'Pause, archive or delete', icon: Trash2 },
];

const NAV_ITEM =
	'group/nav relative flex h-8 shrink-0 items-center gap-2.5 rounded-control pr-2 pl-1 text-body text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring) data-[active=true]:bg-(--alpha-white-6) data-[active=true]:text-(--text-primary)';

function Section({ space, section }: { space: Space; section: ProjectSection }) {
	switch (section) {
		case 'general':
			return (
				<>
					<PageHeading title="General" info="Threads already running keep their model until their next message.">
						For the coordinator and every thread in this project.
					</PageHeading>
					<General key={`general-${space.id}`} space={space} />
				</>
			);
		case 'instructions':
			return (
				<TextBlock
					space={space}
					field="instructions"
					title="Instructions"
					icon={ScrollText}
					help="Read by the coordinator and every thread."
					info="After each repository's own AGENTS.md."
					placeholder="- Keep pull requests small; one concern each."
				/>
			);
		case 'memory':
			return (
				<TextBlock
					space={space}
					field="memory"
					title="Memory"
					icon={BookOpen}
					help="What the coordinator and threads learned."
					info="They add to it; edit or remove anything."
					placeholder="Decisions, conventions and facts a new thread should know."
				/>
			);
		case 'repositories':
			return <Repositories space={space} />;
		case 'usage':
			return <Usage space={space} />;
		case 'lifecycle':
			return <Lifecycle space={space} />;
	}
}

/** The card's frame: the project and section as crumbs with a close button, the sections on the left, the section beside them. */
export function ProjectSettingsCard({ spaceId, section }: { spaceId: string; section: ProjectSection }) {
	const space = useSpace(spaceId);
	const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--border-subtle) pr-2 pl-4 text-body font-medium">
				{space.data ? <SpaceMark space={space.data} size={20} /> : null}
				<span className="min-w-0 truncate text-(--text-secondary)">{space.data?.name ?? 'Project'}</span>
				<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--icon-disabled)" />
				<span className="shrink-0 text-(--text-secondary)">Settings</span>
				<Icon icon={ChevronRight} size={12} className="shrink-0 text-(--icon-disabled)" />
				<span className="min-w-0 truncate text-(--text-primary)">{current.label}</span>
				<span className="flex-1" />
				<IconBtn icon={X} size="sm" label="Close project settings" onClick={closeProjectSettings} />
			</header>
			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				<nav
					aria-label="Project settings"
					data-noscrollbar
					className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-(--border-subtle) px-2.5 py-2 md:w-[232px] md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:pt-2.5 md:pb-4"
				>
					<div className="hidden items-center gap-2 px-2 pt-1 pb-1.5 md:flex">
						<SectionLabel className="shrink-0">Project</SectionLabel>
						<span aria-hidden className="h-px flex-1 bg-(--border-subtle)" />
					</div>
					{SECTIONS.map((item) => (
						<button
							key={item.id}
							type="button"
							data-active={item.id === current.id}
							aria-current={item.id === current.id ? 'page' : undefined}
							onClick={() => openProjectSettings(spaceId, item.id)}
							className={cn(NAV_ITEM, item.id === 'lifecycle' && 'md:mt-3')}
						>
							<span
								className={cn(
									'inline-flex size-6 shrink-0 items-center justify-center text-(--icon-tertiary) group-hover/nav:text-(--icon-secondary)',
									item.id === current.id && 'text-(--accent-text) group-hover/nav:text-(--accent-text)',
									item.id === 'lifecycle' && item.id === current.id && 'text-(--danger-text) group-hover/nav:text-(--danger-text)',
								)}
							>
								<Icon icon={item.icon} size={15} />
							</span>
							<span className="min-w-0 truncate whitespace-nowrap">{item.label}</span>
						</button>
					))}
				</nav>
				<div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-12 md:px-6">
					<div className="flex max-w-[880px] flex-col gap-6 pt-4">
						{space.isError ? <EmptyState icon={Gauge} title="No such project" body={space.error.message} /> : null}
						{space.data ? <Section key={current.id} space={space.data} section={current.id} /> : <Spinner size={12} />}
					</div>
				</div>
			</div>
		</div>
	);
}
