import { PrStatus } from '@/components/pr-status';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CalendarClock, ChevronDown, CircleDot, Clock, Github, GitPullRequest, LayoutDashboard, Library, ListChecks, Maximize2, MessageSquare, Minimize2, PanelRight, Pencil, Play, Plus, Tag, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';
import { Caption, Card, Chip, Pips } from '@/components/instrument';
import { Glyph, type GlyphKind, glyphKind, KIND_LABEL, STATE_COLOR } from '@/components/thread-glyph';
import { ModelLogo, ModelPicker, useModelName, useModels } from '@/components/model-picker';
import { nextRunText, ScheduleEditor, whenItRuns } from '@/components/schedule-editor';
import { Btn, EmptyState, Icon, IconBtn, Switch } from '@/components/signal';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { BurnCard, ProjectPulse, ScheduleTimeline, WaitTracks } from '@/components/project-viz';
import { NextSteps, ThreadStateIcon, useOpenThread } from '@/components/thread-card';
import { Library as LibraryView, type LibrarySource, type Place, spacePlace, taskPlace } from '@/components/library-tab';
import { WorkspacePane } from '@/components/workspace-pane';
import { api, type Automation, type ModelChoice, type Output, repoShort, type Session, type Space } from '@/lib/api';
import { age, until } from '@/lib/format';
import { shownPaths, threadFolders } from '@/lib/project-library';
import { stateOf } from '@/lib/spaces';
import { cn } from '@/lib/utils';
import { defaultSchedule, type Frequency, type Schedule, scheduleProblem } from '../../core/schedule';

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
											<PrStatus thread={thread} full />
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

/** The folder of the project's Library that holds what its threads saved, a folder each. */
const FROM_THREADS = 'From threads';
/** The threads whose files the Library lists, newest first. */
const LISTED_THREADS = 24;

type Entry = { place: Place; agentPath: string; remove: () => Promise<unknown> };

/**
 * The project's Library, shown as a task's is: the files you add for every
 * thread, and under From threads a folder for each thread with what it saved.
 */
function ProjectLibrary({ space, threads }: { space: Space; threads: Session[] }) {
	const queryClient = useQueryClient();
	const files = useQuery({ queryKey: ['space-files', space.id], queryFn: () => api.spaceFiles(space.id) });
	const recent = threads.slice(0, LISTED_THREADS);
	const outputs = useQueries({ queries: recent.map((thread) => ({ queryKey: ['outputs', thread.id], queryFn: () => api.outputs(thread.id), staleTime: 30_000 })) });
	const listed: Output[] = [];
	const entries = new Map<string, Entry>();
	for (const file of files.data?.files ?? []) {
		listed.push({ path: file.path, size: file.size, mtimeMs: Date.parse(file.modifiedAt) });
		entries.set(file.path, {
			place: spacePlace(space.id, file.path),
			agentPath: `../project-files/${file.path}`,
			remove: () => api.deleteSpaceFile(space.id, file.path),
		});
	}
	// A folder per thread, named for it, with its files one click inside (threadFolders, shownPaths).
	const folders = threadFolders(recent);
	recent.forEach((thread, index) => {
		const saved = outputs[index]?.data?.outputs ?? [];
		const shown = shownPaths(saved.map((output) => output.path));
		for (const output of saved) {
			const path = `${FROM_THREADS}/${folders.get(thread.id)}/${shown.get(output.path) ?? output.path}`;
			listed.push({ ...output, path });
			entries.set(path, { place: taskPlace(thread.id, output.path), agentPath: `outputs/${output.path}`, remove: () => api.deleteOutput(thread.id, output.path) });
		}
	});
	const library: LibrarySource = {
		files: files.data ? listed : undefined,
		error: files.error,
		place: (path) => entries.get(path)?.place ?? spacePlace(space.id, path),
		agentPath: (path) => entries.get(path)?.agentPath ?? `../project-files/${path}`,
		upload: (file) => api.uploadSpaceFile(space.id, file),
		remove: (path) => entries.get(path)?.remove() ?? Promise.resolve(),
		refresh: () => {
			void queryClient.invalidateQueries({ queryKey: ['space-files', space.id] });
			for (const thread of recent) void queryClient.invalidateQueries({ queryKey: ['outputs', thread.id] });
		},
		addedTo: 'the project files',
		empty: `Files you add here are for every thread, which finds them in ../project-files. What the threads save shows under ${FROM_THREADS}.`,
	};
	return <LibraryView library={library} />;
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
									<Caption>{repoShort(thread)}</Caption><PrStatus thread={thread} full />
									{runs.length ? (
										<Pips
											label={`${runs.length} checks`}
											items={runs.map((run) => ({ tone: run.status === 'passed' ? 'success' : run.status === 'failed' ? 'danger' : 'neutral', title: run.name }))}
										/>
									) : null}
								</span>
							</button>
							<NextSteps thread={thread} size="xs" />
						</div>
					);
				})}
			</div>
		</Card>
	);
}

/** Chats, for a routine without a repository: a Select item needs a value, and '' is its own. */
const NO_REPO = 'none';

/** The runs a strip shows, newest at the right. */
const RUNS_SHOWN = 14;

/** A run's bar: green once it delivered, red when it failed, amber while it asks, cyan while it works. */
const RUN_COLOR: Record<GlyphKind, string> = {
	...STATE_COLOR,
	resolved: 'color-mix(in oklab, var(--success-base) 62%, var(--neutral-800))',
	idle: 'color-mix(in oklab, var(--success-base) 40%, var(--neutral-700))',
};

/** A routine's recent runs as bars in their thread's state colour, oldest first, each opening its thread. */
function RunStrip({ runs }: { runs: Session[] }) {
	const open = useOpenThread();
	const shown = runs.slice(-RUNS_SHOWN);
	return (
		<span role="group" aria-label="Recent runs" className="flex h-3.5 items-stretch gap-[2px]">
			{Array.from({ length: RUNS_SHOWN - shown.length }, (_, index) => (
				<span key={`empty-${index}`} aria-hidden className="w-1 rounded-[1.5px] bg-(--segment-off)" />
			))}
			{shown.map((thread) => {
				const kind = glyphKind(thread);
				return (
					<button
						key={thread.id}
						type="button"
						onClick={() => open(thread)}
						title={`${thread.title}: ${KIND_LABEL[kind]}`}
						aria-label={`${thread.title}: ${KIND_LABEL[kind]}`}
						className={cn('w-1 rounded-[1.5px] outline-none hover:brightness-150 focus-visible:shadow-(--focus-ring)', kind === 'working' && 'in-sweep')}
						style={{ background: RUN_COLOR[kind] }}
					/>
				);
			})}
		</span>
	);
}

const FREQUENCY_WORD: Record<Frequency, string> = { hourly: 'Hourly', daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly', cron: 'Cron' };

/** What a routine is called: the name its first run gave it, else the start of what it does. */
function routineName(automation: Automation): string {
	if (automation.title) return automation.title;
	if (automation.kind === 'issues') return `Issues labeled “${automation.label}”`;
	return automation.prompt.split('\n')[0].trim() || whenItRuns(automation);
}

/** A small arrow between what starts a routine and where its threads work. */
const Flow = () => <Icon icon={ArrowRight} size={11} className="text-(--icon-tertiary)" />;

function RoutineRow({ automation, space, runs }: { automation: Automation; space: Space; runs: Session[] }) {
	const queryClient = useQueryClient();
	const modelName = useModelName();
	const models = useModels();
	const refresh = () => void queryClient.invalidateQueries({ queryKey: ['space-automations', space.id] });
	const toggle = useMutation({ mutationFn: (enabled: boolean) => api.setAutomationEnabled(automation.id, enabled), onSettled: refresh });
	const run = useMutation({ mutationFn: () => api.runAutomation(automation.id), onSettled: refresh });
	const remove = useMutation({ mutationFn: () => api.deleteAutomation(automation.id), onSettled: refresh });
	const [editing, setEditing] = useState(false);
	const [open, setOpen] = useState(false);
	const repo = space.repos.find((item) => item.id === automation.projectId);
	const model = automation.model ?? space.threadModel ?? models.data?.default ?? null;
	const next = automation.nextRunAt ?? null;
	const last = runs.at(-1);
	const on = automation.enabled;
	if (editing) return <RoutineForm space={space} automation={automation} onDone={() => setEditing(false)} />;
	return (
		<div className="group/routine flex flex-col gap-2 border-t border-(--border-subtle) px-4 py-3">
			<div className="flex min-w-0 items-start gap-3">
				<span
					className={cn(
						'mt-px inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] border',
						on ? 'border-(--accent-border) bg-(--accent-bg-subtle) text-(--accent-text)' : 'border-(--border-subtle) bg-(--well-bg) text-(--icon-tertiary)',
					)}
				>
					<Icon icon={automation.kind === 'issues' ? CircleDot : CalendarClock} size={13} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex min-w-0 items-center gap-1">
						<button
							type="button"
							aria-expanded={open}
							onClick={() => setOpen(!open)}
							className="flex min-w-0 items-center gap-1 rounded-[5px] text-left outline-none focus-visible:shadow-(--focus-ring)"
						>
							<span className={cn('min-w-0 truncate text-[13px] leading-[18px] font-medium', on ? 'text-(--text-primary)' : 'text-(--text-tertiary)')}>{routineName(automation)}</span>
							<Icon icon={ChevronDown} size={12} className={cn('text-(--icon-tertiary) transition-transform duration-(--duration-micro)', open && 'rotate-180')} />
						</button>
						<span className="flex-1" />
						<span className="hidden shrink-0 items-center gap-0.5 group-focus-within/routine:flex group-hover/routine:flex pointer-coarse:flex">
							<Btn size="xs" variant="ghost" icon={Play} disabled={run.isPending} onClick={() => run.mutate()}>
								Run now
							</Btn>
							<IconBtn icon={Pencil} size="xs" label="Edit routine" onClick={() => setEditing(true)} />
							<IconBtn icon={Trash2} size="xs" label="Delete routine" disabled={remove.isPending} onClick={() => remove.mutate()} />
						</span>
						<Switch checked={on} disabled={toggle.isPending} onChange={(enabled) => toggle.mutate(enabled)} label={<span className="sr-only">Enabled</span>} className="ml-1" />
					</div>
					<div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] leading-[17px] text-(--text-tertiary)">
						<span className="truncate">{automation.kind === 'issues' ? 'Checks every 5 minutes' : whenItRuns(automation)}</span>
						<span className="text-(--text-disabled)">·</span>
						{!on ? (
							<span>Paused</span>
						) : automation.schedule && next ? (
							<span title={nextRunText(automation)}>
								Next <span className="in-num text-(--text-primary)">{until(next)}</span>
							</span>
						) : (
							<span>
								{automation.seen.length} {automation.seen.length === 1 ? 'issue' : 'issues'}
							</span>
						)}
					</div>
				</div>
			</div>
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 pl-10">
				<span className="flex min-w-0 flex-wrap items-center gap-1">
					{automation.kind === 'issues' ? (
						<Chip icon={Tag} mono>
							{automation.label}
						</Chip>
					) : (
						<Chip icon={Clock}>{automation.schedule ? FREQUENCY_WORD[automation.schedule.frequency] : 'Schedule'}</Chip>
					)}
					<Flow />
					{repo ? (
						<Chip icon={Github} mono>
							{repo.repoFullName.split('/').pop()}
						</Chip>
					) : (
						<Chip icon={MessageSquare} className="border-dashed bg-transparent text-(--text-tertiary)">
							no repository
						</Chip>
					)}
					{model ? (
						<span className="inline-flex h-5 min-w-0 items-center gap-1 text-[11px] text-(--text-secondary)" title={model}>
							<span aria-hidden className="mr-1 h-3 w-px bg-(--border-subtle)" />
							<ModelLogo model={model} size={14} />
							<span className="truncate">{modelName(model)}</span>
						</span>
					) : null}
					{automation.planFirst ? <Chip icon={ListChecks}>Plans first</Chip> : null}
				</span>
				<span className="ml-auto flex shrink-0 items-center gap-2.5">
					<span className="flex items-center gap-1.5 text-[11px] text-(--text-tertiary)" title={`${runs.length} run${runs.length === 1 ? '' : 's'}`}>
						{last ? <Glyph kind={glyphKind(last)} size={12} /> : null}
						{automation.lastRunAt ? `${age(automation.lastRunAt) === 'now' ? 'just now' : `${age(automation.lastRunAt)} ago`}` : 'Not run yet'}
					</span>
					<RunStrip runs={runs} />
				</span>
			</div>
			{open && automation.prompt ? <p className="m-0 ml-10 rounded-[8px] bg-(--well-bg) px-2.5 py-2 text-[12px] leading-[18px] whitespace-pre-wrap text-(--text-secondary)">{automation.prompt}</p> : null}
			{automation.lastError ? <div className="ml-10 text-[12px] text-(--danger-text)">{automation.lastError}</div> : null}
			{(run.error ?? toggle.error ?? remove.error) ? <div className="ml-10 text-[12px] text-(--danger-text)">{(run.error ?? toggle.error ?? remove.error)?.message}</div> : null}
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
	const [schedule, setSchedule] = useState<Schedule>(automation?.schedule ?? defaultSchedule());
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
				schedule: kind === 'schedule' ? schedule : null,
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
			<ToggleGroup type="single" size="sm" aria-label="Starts" value={kind} onValueChange={(next) => next && setKind(next as Automation['kind'])}>
				<ToggleGroupItem value="schedule" className="text-[12px]">
					On a schedule
				</ToggleGroupItem>
				<ToggleGroupItem value="issues" disabled={!repoId} className="text-[12px]">
					From labeled issues
				</ToggleGroupItem>
			</ToggleGroup>
			<div className="flex flex-wrap items-center gap-2">
				{space.repos.length ? (
					<Select value={repoId || NO_REPO} onValueChange={(next) => setRepoId(next === NO_REPO ? '' : next)}>
						<SelectTrigger aria-label="Repository" className="max-w-[260px] min-w-0 text-[13px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							{space.repos.map((repo) => (
								<SelectItem key={repo.id} value={repo.id} className="text-[13px]">
									{repo.repoFullName}
								</SelectItem>
							))}
							<SelectSeparator />
							<SelectItem value={NO_REPO} className="text-[13px]">
								No repository
							</SelectItem>
						</SelectContent>
					</Select>
				) : null}
				{kind === 'issues' ? <Input aria-label="Label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="label" className="w-32 text-[13px] md:text-[13px]" /> : null}
				<ModelPicker value={{ ...choice, model: choice.model || models.data?.default || '' }} onChange={(change) => setChoice((current) => ({ ...current, ...change }))} side="bottom" />
			</div>
			{kind === 'schedule' ? <ScheduleEditor value={schedule} onChange={setSchedule} /> : null}
			<Textarea
				aria-label="Instructions"
				value={prompt}
				onChange={(event) => setPrompt(event.target.value)}
				rows={3}
				placeholder={kind === 'schedule' ? 'What each run should do' : 'Anything to add to each issue (optional)'}
				className="min-h-[72px] text-[13px] md:text-[13px]"
			/>
			<div className="flex items-center gap-2">
				{save.isError ? <span className="min-w-0 flex-1 text-[12px] text-(--danger-text)">{save.error.message}</span> : <span className="flex-1" />}
				<Btn size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Btn>
				<Btn type="submit" size="sm" variant="primary" disabled={save.isPending || (kind === 'schedule' && (!prompt.trim() || Boolean(scheduleProblem(schedule))))}>
					{automation ? 'Save routine' : 'Add routine'}
				</Btn>
			</div>
		</form>
	);
}

/** Work that starts on its own as threads of this project: on a schedule, or from labeled issues. */
function Routines({ space, threads }: { space: Space; threads: Session[] }) {
	const routines = useQuery({ queryKey: ['space-automations', space.id], queryFn: () => api.spaceAutomations(space.id) });
	const [adding, setAdding] = useState(false);
	const list = routines.data?.automations ?? [];
	const on = list.filter((automation) => automation.enabled).length;
	return (
		<Card
			icon={CalendarClock}
			title="Routines"
			sub={list.length ? `${on} of ${list.length} on` : undefined}
			status={
				adding ? null : (
					<Btn size="xs" variant="secondary" icon={Plus} onClick={() => setAdding(true)}>
						New routine
					</Btn>
				)
			}
		>
			{list.map((automation) => (
				<RoutineRow
					key={automation.id}
					automation={automation}
					space={space}
					runs={threads.filter((thread) => thread.automationId === automation.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))}
				/>
			))}
			{list.length === 0 && !adding && routines.isSuccess ? (
				<div className="flex items-center gap-2 border-t border-(--border-subtle) px-4 py-3">
					<Caption>No routines yet</Caption>
				</div>
			) : null}
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
				{tab === 'Routines' ? <Routines space={space} threads={threads} /> : null}
			</div>
		</WorkspacePane>
	);
});
