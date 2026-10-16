import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, Clock, FileText, GitPullRequest, LayoutDashboard, Library, Maximize2, Minimize2, PanelRight, Pencil, Play, Plus, Trash2, Upload } from 'lucide-react';
import { memo, useRef, useState } from 'react';
import { Caption, Card, CardFooter, Pips } from '@/components/instrument';
import { ModelPicker, useModels } from '@/components/model-picker';
import { Btn, EmptyState, Icon, IconBtn, Switch } from '@/components/signal';
import { BurnCard, ProjectPulse, ScheduleTimeline, WaitTracks } from '@/components/project-viz';
import { NextSteps, prNumber, prSummary, ThreadStateIcon, ThreadStatePill, useOpenThread } from '@/components/thread-card';
import { WorkspacePane } from '@/components/workspace-pane';
import { api, type Automation, type ModelChoice, outputUrl, repoShort, type Session, type Space, spaceFileUrl } from '@/lib/api';
import { age } from '@/lib/format';
import { stateOf } from '@/lib/spaces';
import { cn } from '@/lib/utils';

export const PROJECT_TABS = [
	{ name: 'Overview', icon: LayoutDashboard },
	{ name: 'Library', icon: Library },
	{ name: 'Pull requests', icon: GitPullRequest },
	{ name: 'Routines', icon: CalendarClock },
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number]['name'];

/** A tab like the workspace's: raised when it is the one shown. */
function Tab({ name, icon, count, active, onSelect }: { name: string; icon: typeof Library; count?: number; active: boolean; onSelect: () => void }) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onSelect}
			className="relative flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] pr-2 pl-1.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
		>
			{active ? <span className="absolute inset-0 rounded-[8px] border border-(--card-border) bg-[linear-gradient(180deg,var(--neutral-750),var(--neutral-800))] shadow-(--card-highlight)" /> : null}
			<Icon icon={icon} size={12} className={cn('relative', active ? 'text-(--accent-text)' : 'text-(--icon-tertiary)')} />
			<span className={cn('relative text-[12px] whitespace-nowrap', active ? 'text-(--text-primary)' : 'text-(--text-secondary)')}>{name}</span>
			{count ? <span className="in-num relative inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-(--warning-bg) px-1 text-[10px] text-(--warning-text)">{count}</span> : null}
		</button>
	);
}

/**
 * Overview, read top to bottom: the project's pulse (what it comes to, its
 * states, its bay in the rack, activity), what waits on you as tracks of time, the schedule of every
 * thread to now, what is ready for review, and what it all costs.
 */
function Overview({ space, threads }: { space: Space; threads: Session[] }) {
	const ready = threads.filter((thread) => ['review', 'landing'].includes(stateOf(thread)));
	const openThread = useOpenThread();
	if (threads.length === 0) {
		return (
			<EmptyState
				icon={LayoutDashboard}
				title="Nothing to track yet"
				body="Threads show here as they start: what needs you first, then what is working, then pull requests ready for review."
				className="mt-10"
			/>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			<ProjectPulse space={space} threads={threads} />
			<WaitTracks threads={threads} />
			<ScheduleTimeline threads={threads} />
			{ready.length ? (
				<Card icon={GitPullRequest} title="Ready for review" sub={`${ready.length} pull request${ready.length === 1 ? '' : 's'}`}>
					<div className="flex flex-col">
						{ready.map((thread) => {
							const runs = thread.pullRequest?.runs ?? [];
							return (
								<div key={thread.id} className="flex items-center gap-2.5 border-t border-(--border-subtle) px-4 py-2">
									<ThreadStateIcon thread={thread} size={13} />
									<button type="button" onClick={() => openThread(thread, 'Changes')} className="flex min-w-0 flex-1 flex-col text-left outline-none">
										<span className="truncate text-[13px] hover:underline">{thread.title}</span>
										<span className="flex items-center gap-2">
											<Caption>{prSummary(thread)}</Caption>
											{runs.length ? (
												<Pips label={`${runs.length} checks`} items={runs.map((run) => ({ tone: run.status === 'passed' ? 'success' : run.status === 'failed' ? 'danger' : 'neutral', title: run.name }))} />
											) : null}
										</span>
									</button>
									<NextSteps thread={thread} size="xs" />
								</div>
							);
						})}
					</div>
				</Card>
			) : null}
			<BurnCard space={space} />
		</div>
	);
}

/** Files you add for every thread, then what each thread saved. */
function ProjectLibrary({ space, threads }: { space: Space; threads: Session[] }) {
	const queryClient = useQueryClient();
	const picker = useRef<HTMLInputElement>(null);
	const files = useQuery({ queryKey: ['space-files', space.id], queryFn: () => api.spaceFiles(space.id) });
	const upload = useMutation({
		mutationFn: async (list: File[]) => {
			for (const file of list) await api.uploadSpaceFile(space.id, file);
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['space-files', space.id] }),
	});
	const remove = useMutation({
		mutationFn: (path: string) => api.deleteSpaceFile(space.id, path),
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['space-files', space.id] }),
	});
	const recent = threads.slice(0, 12);
	const outputs = useQueries({ queries: recent.map((thread) => ({ queryKey: ['outputs', thread.id], queryFn: () => api.outputs(thread.id), staleTime: 30_000 })) });
	const produced = recent.flatMap((thread, index) => (outputs[index]?.data?.outputs ?? []).map((output) => ({ thread, output })));
	return (
		<div className="flex flex-col gap-3">
			<Card
				icon={Upload}
				title="Project files"
				sub="every thread can read them"
				footer={
					<CardFooter caption={upload.isError ? <span className="text-(--danger-text)">{upload.error.message}</span> : space.repos.length ? 'In ../project-files beside each repo' : "In ../project-files beside each thread's folder"}>
						<input ref={picker} type="file" multiple hidden onChange={(event) => (upload.mutate([...(event.target.files ?? [])]), (event.target.value = ''))} />
						<Btn size="sm" variant="secondary" icon={Plus} disabled={upload.isPending} onClick={() => picker.current?.click()}>
							{upload.isPending ? 'Adding…' : 'Add files'}
						</Btn>
					</CardFooter>
				}
			>
				<div
					className="flex flex-col"
					onDragOver={(event) => event.preventDefault()}
					onDrop={(event) => {
						event.preventDefault();
						upload.mutate([...event.dataTransfer.files]);
					}}
				>
					{(files.data?.files ?? []).map((file) => (
						<div key={file.path} className="group/file flex h-9 items-center gap-2.5 border-t border-(--border-subtle) px-4">
							<Icon icon={FileText} size={13} className="text-(--icon-tertiary)" />
							<a href={spaceFileUrl(space.id, file.path)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-[13px] hover:underline">
								{file.path}
							</a>
							<Caption>{Math.max(1, Math.round(file.size / 1024))} KB</Caption>
							<IconBtn icon={Trash2} size="xs" label={`Remove ${file.path}`} className="opacity-0 group-hover/file:opacity-100" onClick={() => remove.mutate(file.path)} />
						</div>
					))}
					{files.data && files.data.files.length === 0 ? <div className="border-t border-(--border-subtle) px-4 py-3 text-[12px] text-(--text-disabled)">Drop files here: specs, designs, data the threads should use.</div> : null}
				</div>
			</Card>
			<Card icon={Library} title="From threads" sub={`${produced.length} saved`}>
				<div className="flex flex-col">
					{produced.map(({ thread, output }) => (
						<a
							key={`${thread.id}/${output.path}`}
							href={outputUrl(thread.id, output.path)}
							target="_blank"
							rel="noreferrer"
							className="flex h-9 items-center gap-2.5 border-t border-(--border-subtle) px-4 hover:bg-(--bg-hover)"
						>
							<Icon icon={FileText} size={13} className="text-(--icon-tertiary)" />
							<span className="min-w-0 flex-1 truncate text-[13px]">{output.path}</span>
							<Caption className="max-w-[40%] truncate">{thread.title}</Caption>
						</a>
					))}
					{produced.length === 0 ? <div className="border-t border-(--border-subtle) px-4 py-3 text-[12px] text-(--text-disabled)">Reports, screenshots and exports the threads save show here.</div> : null}
				</div>
			</Card>
		</div>
	);
}

function PullRequests({ threads }: { threads: Session[] }) {
	const openThread = useOpenThread();
	const withPr = threads.filter((thread) => thread.prUrl);
	if (withPr.length === 0) return <EmptyState icon={GitPullRequest} title="No pull requests yet" body="When a thread opens one, it shows here with its checks." className="mt-10" />;
	return (
		<Card icon={GitPullRequest} title="Pull requests" sub={`${withPr.length}`}>
			<div className="flex flex-col">
				{withPr.map((thread) => {
					const runs = thread.pullRequest?.runs ?? [];
					return (
						<div key={thread.id} className="flex items-center gap-2.5 border-t border-(--border-subtle) px-4 py-2.5">
							<ThreadStateIcon thread={thread} size={12} />
							<button type="button" onClick={() => openThread(thread, 'Changes')} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-none">
								<span className="truncate text-[13px] text-(--text-primary)">{thread.title}</span>
								<span className="flex items-center gap-2">
									<Caption>
										{repoShort(thread)} #{prNumber(thread.prUrl)}
									</Caption>
									{runs.length ? (
										<Pips
											label={`${runs.length} checks`}
											items={runs.map((run) => ({ tone: run.status === 'passed' ? 'success' : run.status === 'failed' ? 'danger' : 'neutral', title: run.name }))}
										/>
									) : null}
								</span>
							</button>
							<ThreadStatePill thread={thread} compact />
							<NextSteps thread={thread} size="xs" />
						</div>
					);
				})}
			</div>
		</Card>
	);
}

const FIELD = 'h-8 min-w-0 rounded-lg bg-(--bg-surface) px-2.5 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)';

function RoutineRow({ automation, space }: { automation: Automation; space: Space }) {
	const queryClient = useQueryClient();
	const refresh = () => void queryClient.invalidateQueries({ queryKey: ['space-automations', space.id] });
	const toggle = useMutation({ mutationFn: (enabled: boolean) => api.setAutomationEnabled(automation.id, enabled), onSettled: refresh });
	const run = useMutation({ mutationFn: () => api.runAutomation(automation.id), onSettled: refresh });
	const remove = useMutation({ mutationFn: () => api.deleteAutomation(automation.id), onSettled: refresh });
	const [editing, setEditing] = useState(false);
	const repo = space.repos.find((item) => item.id === automation.projectId);
	if (editing) return <RoutineForm space={space} automation={automation} onDone={() => setEditing(false)} />;
	return (
		<div className="flex flex-col gap-1.5 border-t border-(--border-subtle) px-4 py-2.5">
			<div className="flex items-center gap-2">
				<Icon icon={Clock} size={13} className="text-(--icon-tertiary)" />
				<span className={cn('min-w-0 flex-1 truncate text-[13px]', automation.enabled ? 'text-(--text-primary)' : 'text-(--text-tertiary)')}>
					{automation.kind === 'issues' ? `Issues labeled “${automation.label}”` : `Every ${automation.everyHours} hours`}
				</span>
				<Switch checked={automation.enabled} disabled={toggle.isPending} onChange={(enabled) => toggle.mutate(enabled)} label={<span className="sr-only">Enabled</span>} />
				<Btn size="xs" variant="ghost" icon={Play} disabled={run.isPending} onClick={() => run.mutate()}>
					Run now
				</Btn>
				<IconBtn icon={Pencil} size="xs" label="Edit routine" onClick={() => setEditing(true)} />
				<IconBtn icon={Trash2} size="xs" label="Delete routine" disabled={remove.isPending} onClick={() => remove.mutate()} />
			</div>
			{automation.prompt ? <p className="m-0 line-clamp-2 text-[12px] leading-[17px] text-(--text-secondary)">{automation.prompt}</p> : null}
			<Caption>
				{repo?.repoFullName.split('/').pop() ?? 'No repository'} · {automation.lastRunAt ? `ran ${age(automation.lastRunAt)} ago` : 'not run yet'}
			</Caption>
			{automation.lastError ? <div className="text-[12px] text-(--danger-text)">{automation.lastError}</div> : null}
		</div>
	);
}

/** A routine's settings: a new one, or with `automation` the one being changed. */
function RoutineForm({ space, automation, onDone }: { space: Space; automation?: Automation; onDone: () => void }) {
	const queryClient = useQueryClient();
	const [pickedKind, setKind] = useState<Automation['kind']>(automation?.kind ?? 'schedule');
	const [picked, setRepoId] = useState<string | null>(automation ? automation.projectId : null);
	// The first repository until one is picked, so one added later is picked up too; '' starts threads as chats.
	const repoId = picked === '' || space.repos.some((repo) => repo.id === picked) ? picked! : (space.repos[0]?.id ?? '');
	// Labeled issues belong to a repository; without one a routine runs on a schedule.
	const kind = repoId ? pickedKind : 'schedule';
	const [hours, setHours] = useState(automation?.everyHours ?? 24);
	const [label, setLabel] = useState(automation?.label ?? 'anton');
	const [prompt, setPrompt] = useState(automation?.prompt ?? '');
	const models = useModels();
	const [choice, setChoice] = useState<ModelChoice>({ model: automation ? (automation.model ?? '') : (space.threadModel ?? ''), reasoning: automation?.reasoning ?? null });
	const save = useMutation({
		mutationFn: () => {
			const input = {
				projectId: repoId || null,
				kind,
				label: kind === 'issues' ? label : null,
				everyHours: kind === 'schedule' ? hours : null,
				prompt,
				model: choice.model || null,
				reasoning: choice.reasoning,
				planFirst: automation?.planFirst ?? false,
			};
			return automation ? api.editAutomation(automation.id, input) : api.addSpaceAutomation(space.id, input);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['space-automations', space.id] });
			onDone();
		},
	});
	return (
		<form
			className="flex flex-col gap-2 border-t border-(--border-subtle) px-4 py-3"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<div className="flex flex-wrap gap-1">
				<Btn size="sm" variant={kind === 'schedule' ? 'secondary' : 'ghost'} onClick={() => setKind('schedule')}>
					On a schedule
				</Btn>
				<Btn size="sm" variant={kind === 'issues' ? 'secondary' : 'ghost'} disabled={!repoId} onClick={() => setKind('issues')}>
					From labeled issues
				</Btn>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				{space.repos.length ? (
					<select aria-label="Repository" value={repoId} onChange={(event) => setRepoId(event.target.value)} className={FIELD}>
						{space.repos.map((repo) => (
							<option key={repo.id} value={repo.id}>
								{repo.repoFullName}
							</option>
						))}
						<option value="">No repository</option>
					</select>
				) : null}
				{kind === 'schedule' ? (
					<label className="flex items-center gap-1.5 text-[12px] text-(--text-tertiary)">
						Every
						<input type="number" min={1} max={168} value={hours} onChange={(event) => setHours(Number(event.target.value))} className={cn(FIELD, 'w-16')} />
						hours
					</label>
				) : (
					<input aria-label="Label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="label" className={cn(FIELD, 'w-32')} />
				)}
				<ModelPicker value={{ ...choice, model: choice.model || models.data?.default || '' }} onChange={(change) => setChoice((current) => ({ ...current, ...change }))} side="bottom" />
			</div>
			<textarea
				aria-label="Instructions"
				value={prompt}
				onChange={(event) => setPrompt(event.target.value)}
				rows={3}
				placeholder={kind === 'schedule' ? 'What each run should do' : 'Anything to add to each issue (optional)'}
				className="min-h-[72px] rounded-lg bg-(--bg-surface) px-2.5 py-2 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)"
			/>
			<div className="flex items-center gap-2">
				{save.isError ? <span className="min-w-0 flex-1 text-[12px] text-(--danger-text)">{save.error.message}</span> : <span className="flex-1" />}
				<Btn size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Btn>
				<Btn type="submit" size="sm" variant="primary" disabled={save.isPending || (kind === 'schedule' && !prompt.trim())}>
					{automation ? 'Save routine' : 'Add routine'}
				</Btn>
			</div>
		</form>
	);
}

/** Work that starts on its own as threads of this project: on a schedule, or from labeled issues. */
function Routines({ space }: { space: Space }) {
	const routines = useQuery({ queryKey: ['space-automations', space.id], queryFn: () => api.spaceAutomations(space.id) });
	const [adding, setAdding] = useState(false);
	const list = routines.data?.automations ?? [];
	return (
		<Card
			icon={CalendarClock}
			title="Routines"
			sub="start threads on their own"
			footer={
				adding ? null : (
					<CardFooter caption={`${list.length} routine${list.length === 1 ? '' : 's'} · threads respect the limit of ${space.maxParallel}`}>
						<Btn size="sm" variant="secondary" icon={Plus} onClick={() => setAdding(true)}>
							Add routine
						</Btn>
					</CardFooter>
				)
			}
		>
			{list.map((automation) => (
				<RoutineRow key={automation.id} automation={automation} space={space} />
			))}
			{list.length === 0 && !adding ? <div className="border-t border-(--border-subtle) px-4 py-3 text-[12px] text-(--text-disabled)">A nightly dependency check, a weekly cleanup, or every issue labeled for Anton.</div> : null}
			{adding ? <RoutineForm space={space} onDone={() => setAdding(false)} /> : null}
		</Card>
	);
}

/**
 * The right panel while the coordinator is selected: about the whole project.
 * Overview first (what needs you, what runs, what is ready), then the
 * Library, pull requests and routines. A thread's own panels replace it when
 * a thread is selected.
 */
export const ProjectPanel = memo(function ProjectPanel({
	space,
	threads,
	tab,
	onTab,
	expanded,
	onToggleExpanded,
	onClose,
}: {
	space: Space;
	threads: Session[];
	tab: ProjectTab;
	onTab: (tab: ProjectTab) => void;
	expanded: boolean;
	onToggleExpanded: () => void;
	onClose: () => void;
}) {
	return (
		<WorkspacePane expanded={expanded}>
			<div className="flex h-11 min-w-0 shrink-0 items-center gap-2 px-2">
				{/* On a phone the panel covers the coordinator; this goes back to it. */}
				<IconBtn icon={ArrowLeft} size="sm" label="Back to the coordinator" onClick={onClose} className="shrink-0 @min-[700px]/workspace:hidden" />
				<div data-noscrollbar role="tablist" aria-label="Project panels" className="flex min-w-0 flex-auto items-center gap-0.5 overflow-x-auto overflow-y-hidden">
					{PROJECT_TABS.map((item) => (
						<Tab
							key={item.name}
							name={item.name}
							icon={item.icon}
							active={tab === item.name}
							onSelect={() => onTab(item.name)}
						/>
					))}
				</div>
				<IconBtn
					icon={expanded ? Minimize2 : Maximize2}
					size="sm"
					label={expanded ? 'Restore the conversation' : 'Expand the panel'}
					onClick={onToggleExpanded}
					className="hidden @min-[700px]/workspace:inline-flex"
				/>
				<IconBtn icon={PanelRight} size="sm" label="Hide the panel" onClick={onClose} className="hidden @min-[700px]/workspace:inline-flex" />
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
				{tab === 'Overview' ? <Overview space={space} threads={threads} /> : null}
				{tab === 'Library' ? <ProjectLibrary space={space} threads={threads} /> : null}
				{tab === 'Pull requests' ? <PullRequests threads={threads} /> : null}
				{tab === 'Routines' ? <Routines space={space} /> : null}
			</div>
		</WorkspacePane>
	);
});
