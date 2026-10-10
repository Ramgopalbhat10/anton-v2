import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, BookOpen, Coins, FolderGit2, Gauge, Layers, Plus, ScrollText, Settings2, Trash2, Waypoints, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Caption, ShareRow, StatRow } from '@/components/instrument';
import { ModelPicker, useModels } from '@/components/model-picker';
import { MenuButton } from '@/components/nav';
import { SpaceMark } from '@/components/project-sidebar';
import { AREA } from '@/components/repo-settings';
import { Block, FIELD, PageHeading, SaveState, Select, SettingRow, SubBlock } from '@/components/settings/parts';
import { Btn, EmptyState, IconBtn, Menu, MenuContent, MenuItem, MenuTrigger, Spinner } from '@/components/signal';
import { api, type Autonomy, type ModelChoice, type Space, type SpaceChange } from '@/lib/api';
import { dollars, tokens } from '@/lib/format';
import { useProjects } from '@/lib/projects';
import { useSpace } from '@/lib/spaces';

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

/** Name, goal, the coordinator's and threads' models, how many threads run at once, and whether the coordinator starts them. */
function General({ space }: { space: Space }) {
	const models = useModels();
	const save = useSave(space);
	const [name, setName] = useState(space.name);
	const [icon, setIcon] = useState(space.icon ?? '');
	const [goal, setGoal] = useState(space.goal);
	const [coordinator, setCoordinator] = useState<ModelChoice>({ model: space.coordinatorModel ?? '', reasoning: space.coordinatorReasoning });
	const [thread, setThread] = useState<ModelChoice>({ model: space.threadModel ?? '', reasoning: space.threadReasoning });
	const [maxParallel, setMaxParallel] = useState(space.maxParallel);
	const [autonomy, setAutonomy] = useState(space.autonomy);
	const fallback = models.data?.default ?? '';
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate({
					name: name.trim(),
					icon: icon.trim() || null,
					goal,
					coordinatorModel: coordinator.model || null,
					coordinatorReasoning: coordinator.reasoning,
					threadModel: thread.model || null,
					threadReasoning: thread.reasoning,
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
				<div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2">
					<input aria-label="Icon" value={icon} maxLength={4} onChange={(event) => setIcon(event.target.value)} placeholder={name.charAt(0).toUpperCase() || 'P'} className={`${FIELD} text-center`} />
					<input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" className={FIELD} />
				</div>
				<textarea
					aria-label="Goal"
					value={goal}
					onChange={(event) => setGoal(event.target.value)}
					rows={2}
					placeholder="What this project is for: ship the billing rewrite, keep the docs current…"
					className={`${AREA} text-[13px] leading-[19px]`}
				/>
				<SubBlock label="Models">
					<SettingRow title="Coordinator" help="Plans, starts and tracks threads. A small, fast model is enough; low reasoning by default.">
						<ModelPicker value={{ model: coordinator.model || fallback, reasoning: coordinator.reasoning ?? 'low' }} onChange={(change) => setCoordinator((current) => ({ ...current, ...change }))} side="bottom" />
					</SettingRow>
					<SettingRow title="Threads" help="Each thread's agent, unless a thread or routine picks its own.">
						<ModelPicker value={{ model: thread.model || fallback, reasoning: thread.reasoning }} onChange={(change) => setThread((current) => ({ ...current, ...change }))} side="bottom" />
					</SettingRow>
				</SubBlock>
				<SubBlock label="Running threads">
					<div className="grid gap-3 sm:grid-cols-2">
						<Select label="At once" icon={Layers} value={maxParallel} options={PARALLEL} onChange={setMaxParallel} help="More wait as queued and start when one finishes." />
						<Select label="The coordinator" icon={Waypoints} value={autonomy} options={AUTONOMY} onChange={setAutonomy} help="Suggested threads show as cards to start with one click." />
					</div>
				</SubBlock>
			</Block>
		</form>
	);
}

/** A text the coordinator and every thread read, saved on its own. */
function TextBlock({ space, field, title, icon, help, placeholder }: { space: Space; field: 'instructions' | 'memory'; title: string; icon: typeof BookOpen; help: string; placeholder: string }) {
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
			footer={
				<>
					<SaveState pending={save.isPending} success={save.isSuccess} error={save.error} />
					<Btn size="sm" disabled={save.isPending || text === space[field]} onClick={() => save.mutate({ [field]: text })}>
						{save.isPending ? 'Saving…' : 'Save'}
					</Btn>
				</>
			}
		>
			<textarea value={text} onChange={(event) => setText(event.target.value)} rows={6} placeholder={placeholder} className={`${AREA} text-[13px] leading-[19px]`} />
		</Block>
	);
}

/** The repositories threads can work on: one at least. */
function Repositories({ space }: { space: Space }) {
	const save = useSave(space);
	const projects = useProjects();
	const others = (projects.data?.projects ?? []).filter((project) => !space.repoIds.includes(project.id));
	return (
		<Block
			title="Repositories"
			icon={FolderGit2}
			help="Threads work on one of these each, on their own branch. Removing one keeps its threads."
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
						<span className="min-w-0 flex-1 truncate text-[13px]">{repo.repoFullName}</span>
						<Caption>{repo.defaultBranch}</Caption>
						<IconBtn
							icon={X}
							size="xs"
							label={`Remove ${repo.repoFullName}`}
							disabled={space.repos.length === 1 || save.isPending}
							onClick={() => save.mutate({ repoIds: space.repoIds.filter((id) => id !== repo.id) })}
						/>
					</div>
				))}
			</div>
			{save.isError ? <span className="text-[12px] text-(--danger-text)">{save.error.message}</span> : null}
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
			void navigate({ to: '/projects' });
		},
	});
	return (
		<Block
			title="Pause, archive or delete"
			icon={Trash2}
			className="border-(--danger-border)"
			help="Paused projects queue new threads instead of starting them. Archived ones leave the sidebar. Deleting removes the project, its coordinator conversation and its files; its threads stay as ordinary tasks."
			footer={
				<>
					{remove.isError ? <span className="text-[12px] text-(--danger-text)">{remove.error.message}</span> : null}
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

export function ProjectSettingsPage() {
	const { spaceId } = useParams({ from: '/projects/$spaceId/settings' });
	const space = useSpace(spaceId);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--border-subtle) pr-4 pl-2 text-[13px] md:pl-4">
				<MenuButton />
				<Link to="/projects/$spaceId" params={{ spaceId }} className="flex items-center gap-1.5 text-(--text-secondary) hover:text-(--text-primary)">
					<ArrowLeft aria-hidden size={13} strokeWidth={1.5} />
					{space.data ? <SpaceMark space={space.data} size={18} /> : null}
					<span className="truncate">{space.data?.name ?? 'Project'}</span>
				</Link>
				<span className="text-(--text-disabled)">/</span>
				<span className="font-medium">Settings</span>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-12 md:px-6">
				<div className="mx-auto flex max-w-[820px] flex-col gap-6">
					{space.isError ? <EmptyState icon={Gauge} title="No such project" body={space.error.message} /> : null}
					{space.data ? (
						<>
							<PageHeading title={space.data.name}>Settings for the coordinator and every thread in this project. Threads already running keep their model until their next message.</PageHeading>
							<General key={`general-${space.data.id}`} space={space.data} />
							<TextBlock
								space={space.data}
								field="instructions"
								title="Instructions"
								icon={ScrollText}
								help="Read by the coordinator and every thread, after each repository's own AGENTS.md."
								placeholder="- Keep pull requests small; one concern each."
							/>
							<TextBlock
								space={space.data}
								field="memory"
								title="Memory"
								icon={BookOpen}
								help="What the coordinator and threads learned about this project. They add to it; edit or remove anything."
								placeholder="Decisions, conventions and facts a new thread should know."
							/>
							<Repositories space={space.data} />
							<Usage space={space.data} />
							<Lifecycle space={space.data} />
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}
