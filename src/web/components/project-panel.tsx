import { PrStatus } from '@/components/pr-status';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CalendarClock, ChevronDown, CircleDot, Clock, Filter, Github, GitPullRequest, LayoutDashboard, Library, ListChecks, Maximize2, MessageSquare, Minimize2, PanelRight, Pencil, Play, Plus, Tag, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';
import { Caption, Card, Chip, PanelTab, PanelTabs, Pips } from '@/components/instrument';
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
								<div key={thread.id} className="flex items-center gap-2.5 border-t border-(--line) px-4 py-2">
									<ThreadStateIcon thread={thread} size={13} />
									<button type="button" onClick={() => openThread(thread, thread.prUrl ? 'PR' : 'Changes')} className="flex min-w-0 flex-1 flex-col text-left outline-none">
										<span className="truncate text-body hover:underline">{thread.title}</span>
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
						<div key={thread.id} className="flex items-center gap-2.5 border-t border-(--line) px-4 py-2.5">
							<ThreadStateIcon thread={thread} size={12} />
							<button type="button" onClick={() => openThread(thread, 'PR')} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-none">
								<span className="truncate text-body text-(--text)">{thread.title}</span>
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

/** A run's bar: green once it delivered, red when it failed, amber while it asks, blue while it works. */
const RUN_COLOR: Record<GlyphKind, string> = {
	...STATE_COLOR,
	resolved: 'color-mix(in oklab, var(--ok) 62%, var(--bg-overlay))',
	idle: 'color-mix(in oklab, var(--ok) 40%, var(--bg-active))',
};

/** A routine's recent runs as bars in their thread's state colour, oldest first, each opening its thread. */
function RunStrip({ runs }: { runs: Session[] }) {
	const open = useOpenThread();
	const shown = runs.slice(-RUNS_SHOWN);
	return (
		<span role="group" aria-label="Recent runs" className="flex h-3.5 items-stretch gap-[2px]">
			{Array.from({ length: RUNS_SHOWN - shown.length }, (_, index) => (
				<span key={`empty-${index}`} aria-hidden className="w-1 rounded-mark bg-(--bg-active)" />
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
						className={cn('w-1 rounded-mark outline-none hover:brightness-150 focus-visible:shadow-(--focus)', kind === 'working' && 'in-sweep')}
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
const Flow = () => <Icon icon={ArrowRight} size={11} className="text-(--text-3)" />;

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
		<div className="group/routine flex flex-col gap-2 border-t border-(--line) px-4 py-3">
			<div className="flex min-w-0 items-start gap-3">
				<span
					className={cn(
						'mt-px inline-flex size-7 shrink-0 items-center justify-center',
						on ? 'text-(--accent-text)' : 'text-(--text-3)',
					)}
				>
					<Icon icon={automation.kind === 'issues' ? CircleDot : CalendarClock} size={16} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex min-w-0 items-center gap-1">
						<button
							type="button"
							aria-expanded={open}
							onClick={() => setOpen(!open)}
							className="flex min-w-0 items-center gap-1 rounded-control text-left outline-none focus-visible:shadow-(--focus)"
						>
							<span className={cn('min-w-0 truncate text-body leading-[18px] font-medium', on ? 'text-(--text)' : 'text-(--text-3)')}>{routineName(automation)}</span>
							<Icon icon={ChevronDown} size={12} className={cn('text-(--text-3) transition-transform duration-(--t-fast)', open && 'rotate-180')} />
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
					<div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-small leading-[17px] text-(--text-3)">
						<span className="truncate">{automation.kind === 'issues' ? 'Checks every 5 minutes' : whenItRuns(automation)}</span>
						<span className="text-(--text-4)">·</span>
						{!on ? (
							<span>Paused</span>
						) : automation.schedule && next ? (
							<span title={nextRunText(automation)}>
								Next <span className="in-num text-(--text)">{until(next)}</span>
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
						<Chip icon={MessageSquare} className="border-dashed bg-transparent text-(--text-3)">
							no repository
						</Chip>
					)}
					{model ? (
						<span className="inline-flex h-5 min-w-0 items-center gap-1 text-micro text-(--text-2)" title={model}>
							<span aria-hidden className="mr-1 h-3 w-px bg-(--line)" />
							<ModelLogo model={model} size={14} />
							<span className="truncate">{modelName(model)}</span>
						</span>
					) : null}
					{automation.planFirst ? <Chip icon={ListChecks}>Plans first</Chip> : null}
					{automation.gate ? (
						<Chip icon={Filter} mono>
							{automation.gate.split('/').pop()}
						</Chip>
					) : null}
				</span>
				<span className="ml-auto flex shrink-0 items-center gap-2.5">
					<span className="flex items-center gap-1.5 text-micro text-(--text-3)" title={`${runs.length} run${runs.length === 1 ? '' : 's'}`}>
						{last ? <Glyph kind={glyphKind(last)} size={12} /> : null}
						{automation.lastRunAt ? `${age(automation.lastRunAt) === 'now' ? 'just now' : `${age(automation.lastRunAt)} ago`}` : 'Not run yet'}
					</span>
					<RunStrip runs={runs} />
				</span>
			</div>
			{open && automation.prompt ? <p className="m-0 ml-10 rounded-control bg-(--bg-raised) px-2.5 py-2 text-small leading-[18px] whitespace-pre-wrap text-(--text-2)">{automation.prompt}</p> : null}
			{automation.gate && automation.lastGate && !automation.lastGate.run ? (
				<div className="ml-10 text-small text-(--text-3)">
					Skipped {age(automation.lastGate.at) === 'now' ? 'just now' : `${age(automation.lastGate.at)} ago`}
					{automation.lastGate.reason ? `: ${automation.lastGate.reason}` : ''}
				</div>
			) : null}
			{automation.lastError ? <div className="ml-10 text-small text-(--bad)">{automation.lastError}</div> : null}
			{(run.error ?? toggle.error ?? remove.error) ? <div className="ml-10 text-small text-(--bad)">{(run.error ?? toggle.error ?? remove.error)?.message}</div> : null}
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
	const [gate, setGate] = useState(automation?.gate ?? '');
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
				gate: kind === 'schedule' ? gate.trim() || null : null,
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
			className="flex flex-col gap-2 border-t border-(--line) px-4 py-3"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<ToggleGroup type="single" size="sm" aria-label="Starts" value={kind} onValueChange={(next) => next && setKind(next as Automation['kind'])}>
				<ToggleGroupItem value="schedule" className="text-small">
					On a schedule
				</ToggleGroupItem>
				<ToggleGroupItem value="issues" disabled={!repoId} className="text-small">
					From labeled issues
				</ToggleGroupItem>
			</ToggleGroup>
			<div className="flex flex-wrap items-center gap-2">
				{space.repos.length ? (
					<Select value={repoId || NO_REPO} onValueChange={(next) => setRepoId(next === NO_REPO ? '' : next)}>
						<SelectTrigger aria-label="Repository" className="max-w-[260px] min-w-0 text-body">
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							{space.repos.map((repo) => (
								<SelectItem key={repo.id} value={repo.id} className="text-body">
									{repo.repoFullName}
								</SelectItem>
							))}
							<SelectSeparator />
							<SelectItem value={NO_REPO} className="text-body">
								No repository
							</SelectItem>
						</SelectContent>
					</Select>
				) : null}
				{kind === 'issues' ? <Input aria-label="Label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="label" className="w-32 text-body md:text-body" /> : null}
				<ModelPicker value={{ ...choice, model: choice.model || models.data?.default || '' }} onChange={(change) => setChoice((current) => ({ ...current, ...change }))} side="bottom" />
			</div>
			{kind === 'schedule' ? <ScheduleEditor value={schedule} onChange={setSchedule} /> : null}
			<Textarea
				aria-label="Instructions"
				value={prompt}
				onChange={(event) => setPrompt(event.target.value)}
				rows={3}
				placeholder={kind === 'schedule' ? 'What each run should do' : 'Anything to add to each issue (optional)'}
				className="min-h-[72px] text-body md:text-body"
			/>
			{kind === 'schedule' ? (
				<label className="flex flex-col gap-1">
					<span className="text-small text-(--text-2)">Run only when a skill's script says so (optional)</span>
					<Input
						aria-label="Gate"
						value={gate}
						onChange={(event) => setGate(event.target.value)}
						placeholder="skill-name/scripts/gate.js"
						className="font-mono text-small md:text-small"
					/>
				</label>
			) : null}
			<div className="flex items-center gap-2">
				{save.isError ? <span className="min-w-0 flex-1 text-small text-(--bad)">{save.error.message}</span> : <span className="flex-1" />}
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
				<div className="flex items-center gap-2 border-t border-(--line) px-4 py-3">
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
				<PanelTabs label="Project panels">
					{PROJECT_TABS.map((item) => (
						<PanelTab key={item.name} on={tab === item.name} mark={<Icon icon={item.icon} size={12} />} onSelect={() => onTab(item.name)}>
							{item.name}
						</PanelTab>
					))}
				</PanelTabs>
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
