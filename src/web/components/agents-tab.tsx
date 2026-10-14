import { ArrowLeft, Bot, ChevronDown, CornerDownRight } from 'lucide-react';
import { HoverCard } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { Card, Caption, StatRow, Status, type Tone } from '@/components/instrument';
import { AgentTile, decisionsOf, lookOf, plainLine, RunMeta, runElapsed, runEnd, spanOf, StatusGlyph, stepBody, StopRunButton, stepTone, titleOf, useNow, useSubagentRuns, WORK, type WorkKind, workKind } from '@/components/subagents';
import type { StepDetail, SubagentRun, SubagentStep } from '@/lib/api';
import { elapsed, fineDollars, tokens } from '@/lib/format';
import { cn } from '@/lib/utils';
import { focusRun, useFocusedRun } from '@/lib/workspace';

/*
 * The Agents panel: every piece of work the agent handed to a subagent, live.
 * The list shows who is working and what each finished with; a run opens into
 * its transcript: the brief, each step as it happens, and the answer.
 */

const STATUS_LABEL: Record<SubagentRun['status'], string> = { running: 'Working', done: 'Finished', failed: 'Failed', stopped: 'Stopped' };

/** What a finished run's result is, by how it ended. */
const RESULT_LABEL: Record<SubagentRun['status'], string> = { running: 'Answer', done: 'Answer', failed: 'Why it failed', stopped: 'Stopped' };
const RESULT_HEADING: Record<SubagentRun['status'], string> = { running: 'Answer to the agent', done: 'Answer to the agent', failed: 'Why it failed', stopped: 'Stopped' };

/** Steps as ticks in their colours, newest at the right, the last one lit while the run works. */
function StepTicks({ steps, live }: { steps: SubagentStep[]; live: boolean }) {
	const shown = steps.slice(-40);
	return (
		<span aria-hidden className="flex h-3 min-w-0 items-end gap-[2px] overflow-hidden">
			{shown.map((step, index) => {
				const current = live && index === shown.length - 1;
				return (
					<span
						key={step.id}
						className={cn('w-[3px] shrink-0 rounded-[1px]', current && 'in-pulse')}
						style={{ height: 12, background: current ? 'var(--accent-base)' : stepTone(step), opacity: current ? 1 : 0.85 }}
					/>
				);
			})}
		</span>
	);
}

function RunCard({ run, now, onOpen }: { run: SubagentRun; now: number; onOpen: () => void }) {
	const live = run.status === 'running';
	const latest = run.steps[run.steps.length - 1];
	// What it is doing now, or what it came back with, in one line.
	const headline = live ? (run.writing ? plainLine(run.writing.split('\n').pop()) : latest ? stepBody(latest).body : null) : run.status === 'stopped' ? 'Stopped by you' : plainLine(run.result);
	return (
		<button
			type="button"
			onClick={onOpen}
			className="in-card flex w-full min-w-0 flex-col gap-2 px-3 py-2.5 text-left outline-none hover:border-(--border-strong) focus-visible:shadow-(--focus-ring)"
		>
			<span className="flex min-w-0 items-center gap-2.5">
				<AgentTile agent={run.agent} running={live} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="font-mono text-[10.5px] tracking-[0.06em] uppercase" style={{ color: lookOf(run.agent).tone }}>
						{lookOf(run.agent).label}
					</span>
					<span className="truncate text-[12.5px] text-(--text-primary)">{titleOf(run.prompt, run.description ?? undefined)}</span>
				</span>
				<span className={cn('flex shrink-0 items-center gap-1.5 text-[11px]', run.status === 'failed' ? 'text-(--danger-text)' : 'text-(--text-tertiary)')}>
					<StatusGlyph status={run.status} />
					{STATUS_LABEL[run.status]}
				</span>
			</span>
			{headline ? (
				<span className={cn('truncate pl-[32px] text-[11.5px]', run.status === 'failed' ? 'text-(--danger-text)' : 'text-(--text-tertiary)', live && 'agent-live-line')}>
					<span>{headline}</span>
				</span>
			) : null}
			<span className="flex min-w-0 items-center gap-3 pl-[32px]">
				<StepTicks steps={run.steps} live={live} />
				<RunMeta run={run} now={now} className="ml-auto" />
			</span>
		</button>
	);
}

/** Runs started within this long of the newest one are drawn together, as one burst of work. */
const BATCH_MS = 10 * 60_000;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The most runs at work at once in a burst. */
function peakOf(runs: SubagentRun[], now: number): number {
	const edges = runs.flatMap((run) => [
		{ at: Date.parse(run.startedAt), step: 1 },
		{ at: runEnd(run, now), step: -1 },
	]);
	edges.sort((a, b) => a.at - b.at || a.step - b.step);
	let open = 0;
	let peak = 0;
	for (const edge of edges) peak = Math.max(peak, (open += edge.step));
	return peak;
}

const KIND_ORDER = Object.keys(WORK) as WorkKind[];

/** How many steps of each kind of work, most first. */
export function workMix(runs: SubagentRun[]): Array<{ kind: WorkKind; count: number }> {
	const counts = new Map<WorkKind, number>();
	for (const run of runs) for (const step of run.steps) counts.set(workKind(step.tool), (counts.get(workKind(step.tool)) ?? 0) + 1);
	return [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/**
 * The latest burst in a sentence: who ran, side by side or one after
 * another, for how long; then what the work mostly was.
 */
export function burstLine(runs: SubagentRun[], now: number): { headline: string; why: string } {
	const agents = new Set(runs.map((run) => run.agent));
	const noun = (count: number) => plural(count, agents.size === 1 ? lookOf(runs[0]?.agent ?? 'agent').label.toLowerCase() : 'agent');
	const working = runs.filter((run) => run.status === 'running').length;
	const failed = runs.filter((run) => run.status === 'failed').length;
	const span = spanOf(runs, now);
	const peak = peakOf(runs, now);
	const together = runs.length < 2 ? '' : peak === runs.length ? ' side by side' : peak > 1 ? ` ${peak} at a time` : ' one after another';
	const headline = working ? `${noun(working)} working${runs.length > working ? `, ${runs.length - working} finished` : ''}` : `${noun(runs.length)} ran${together} for ${elapsed(span.to - span.from)}`;
	const mix = workMix(runs);
	const total = mix.reduce((sum, item) => sum + item.count, 0);
	const top = mix[0];
	const kinds = mix
		.slice(0, 3)
		.map((item) => WORK[item.kind].doing)
		.join(', ')
		.replace(/, ([^,]*)$/, ' and $1');
	let work = 'No steps yet.';
	if (top && top.count === total) work = `All ${WORK[top.kind].doing}: ${plural(total, 'step')}.`;
	else if (top && top.count / total > 0.5) work = `Mostly ${WORK[top.kind].doing}: ${top.count} of ${plural(total, 'step')}.`;
	else if (top) work = `A mix of ${kinds} over ${plural(total, 'step')}.`;
	return { headline, why: failed ? `${failed} failed. ${work}` : work };
}

/** How wide a second of the timeline draws; a longer burst scrolls sideways rather than squeezing its steps. */
const PX_PER_SECOND = 8;
/** The lanes' label column, kept in view while the timeline scrolls. */
const LABEL_PX = 156;
/** The label column covers the scroll's edge and fades the lanes passing under it. */
const LABEL_EDGE = '-2px 0 0 var(--card-bg), 10px 0 10px -6px var(--card-bg)';

/** A round step for a time axis about one tick per 90 pixels. */
function tickStep(totalMs: number, widthPx: number): number {
	const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((seconds) => seconds * 1000);
	const wanted = Math.max(2, Math.floor(widthPx / 90));
	return steps.find((step) => totalMs / step <= wanted) ?? steps[steps.length - 1];
}

/** A duration, in milliseconds under a second so a quick step does not read "0s". */
const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : elapsed(ms));

/** "0:42" or "12:05" from the start of the burst. */
const mark = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

/**
 * One step of a lane as a phase: from when it started to when the next one
 * did (the tool, then the model thinking on what it returned), in its kind's
 * colour. Resting on it shows what it was, when, and how long it took.
 */
function Phase({ step, run, next, from, span, now }: { step: SubagentStep; run: SubagentRun; next?: SubagentStep; from: number; span: number; now: number }) {
	const start = Date.parse(step.at);
	const end = next ? Date.parse(next.at) : runEnd(run, now);
	const kind = WORK[workKind(step.tool)];
	const { icon, body } = stepBody(step);
	const tool = step.durationMs ?? (step.state === 'running' ? Math.max(0, now - start) : null);
	return (
		<HoverCard.Root openDelay={60} closeDelay={60}>
			<HoverCard.Trigger asChild>
				<span
					tabIndex={-1}
					className={cn('absolute inset-y-0 rounded-[2px] hover:brightness-150', step.state === 'running' && 'in-pulse')}
					style={{ left: `${((start - from) / span) * 100}%`, width: `max(calc(${((Math.max(end, start) - start) / span) * 100}% - 1px), 2px)`, background: stepTone(step) }}
				/>
			</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content side="top" sideOffset={8} collisionPadding={12} className="in-pop z-50 flex w-[280px] flex-col gap-1.5 px-3 py-2.5 outline-none">
					<span className="flex items-center gap-1.5">
						<span className="size-[7px] rounded-[2px]" style={{ background: stepTone(step) }} />
						<span className={cn('in-caption', step.state === 'failed' ? 'text-(--danger-text)' : 'text-(--text-secondary)')}>{step.state === 'failed' ? 'Failed' : kind.label}</span>
						<span className="in-caption ml-auto">at {mark(start - from)}</span>
					</span>
					<span className="flex min-w-0 items-start gap-2 text-[12.5px] leading-[18px] text-(--text-primary)">
						<Icon icon={icon} size={13} className="mt-[2px] shrink-0 text-(--icon-tertiary)" />
						<span className="line-clamp-3 min-w-0 break-words">{body}</span>
					</span>
					<span className="in-num text-[11px] text-(--text-tertiary)">
						{[tool === null ? null : `tool ${took(tool)}`, `phase ${took(Math.max(0, end - start))}`, lookOf(run.agent).label.toLowerCase()].filter(Boolean).join(' · ')}
					</span>
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

/**
 * The panel's summary: what the latest burst came to in a sentence, then its
 * runs as lanes on one time axis, each step a phase in its kind's colour to
 * rest on, scrolling sideways when the burst is long; then runs, steps,
 * tokens and what the decision model spent across the task.
 */
function Overview({ sessionId, runs, now }: { sessionId: string; runs: SubagentRun[]; now: number }) {
	const working = runs.filter((run) => run.status === 'running').length;
	const failed = runs.filter((run) => run.status === 'failed').length;
	const newest = Math.max(...runs.map((run) => Date.parse(run.startedAt)));
	const batch = runs.filter((run) => Date.parse(run.startedAt) >= newest - BATCH_MS).slice(0, 8).reverse();
	const line = burstLine(batch, now);
	const mix = workMix(batch);
	const { from, to } = spanOf(batch, now);
	const span = to - from;
	const trackPx = (span / 1000) * PX_PER_SECOND;
	const step = tickStep(span, Math.max(trackPx, 320));
	const ticks = Array.from({ length: Math.floor(span / step) + 1 }, (_, index) => index * step);
	const jev = runs.map(decisionsOf).reduce((sum, item) => ({ decisions: sum.decisions + item.decisions, cost: sum.cost + item.cost }), { decisions: 0, cost: 0 });
	const stats: Array<{ label: string; value: string; tone?: Tone; title?: string }> = [
		{ label: working ? 'working' : 'runs', value: String(working || runs.length), tone: working ? 'accent' : undefined },
		{ label: 'steps', value: String(runs.reduce((sum, run) => sum + run.steps.length, 0)) },
		{ label: 'tokens', value: tokens(runs.reduce((sum, run) => sum + run.tokens, 0)) },
		...(jev.decisions ? [{ label: 'Jev', value: fineDollars(jev.cost), title: `${jev.decisions} decisions by Jev, the decision model that drives the browser` }] : []),
	];
	return (
		<Card
			as="div"
			label="Agents overview"
			title="Agents"
			sub="this task"
			status={working ? <Status tone="accent" pulse>{working} working</Status> : failed ? <Status tone="danger">{failed} failed</Status> : <Status tone="success">All done</Status>}
		>
			<div className="flex flex-col gap-0.5 px-4 pb-3">
				<span className="text-[14px] leading-[20px] font-medium text-pretty text-(--text-primary)">{line.headline}</span>
				<span className="text-[12px] leading-[17px] text-(--text-tertiary)">{line.why}</span>
			</div>
			<div className="flex flex-col gap-2 border-t border-(--border-subtle) pt-3 pb-3">
				<div className="flex items-center gap-3 px-4">
					<Caption className="flex-1">{batch.length === runs.length ? 'Timeline' : 'Latest runs'}</Caption>
					<Caption className="in-num">{elapsed(span)}</Caption>
				</div>
				<div className="overflow-x-auto overflow-y-hidden pb-1">
					<div className="flex flex-col" style={{ width: `max(100%, ${LABEL_PX + trackPx + 32}px)` }}>
						{batch.map((run) => (
							<div key={run.id} className="group/lane flex h-11 min-w-0 items-center pr-4">
								<button
									type="button"
									title={titleOf(run.prompt, run.description ?? undefined)}
									onClick={() => focusRun(sessionId, run.id)}
									className="sticky left-0 z-10 flex h-full shrink-0 items-center gap-2 bg-(--card-bg) pr-3 pl-4 text-left outline-none focus-visible:shadow-(--focus-ring)"
									style={{ width: LABEL_PX, boxShadow: LABEL_EDGE }}
								>
									<AgentTile agent={run.agent} running={run.status === 'running'} size={20} />
									<span className="flex min-w-0 flex-col">
										<span className="truncate text-[12px] leading-[16px] text-(--text-primary) group-hover/lane:underline">{titleOf(run.prompt, run.description ?? undefined)}</span>
										<span className="in-num truncate text-[10.5px] leading-[14px] text-(--text-tertiary)">
											{run.steps.length} steps · {elapsed(runElapsed(run, now))}
										</span>
									</span>
								</button>
								<span className="relative h-3 min-w-0 flex-1 rounded-[3px] bg-(--segment-off)/60">
									<span
										aria-hidden
										className="absolute inset-y-[5px] rounded-full bg-(--border-default)"
										style={{ left: `${((Date.parse(run.startedAt) - from) / span) * 100}%`, width: `${((runEnd(run, now) - Date.parse(run.startedAt)) / span) * 100}%` }}
									/>
									{run.steps.map((entry, index) => (
										<Phase key={entry.id} step={entry} run={run} next={run.steps[index + 1]} from={from} span={span} now={now} />
									))}
								</span>
							</div>
						))}
						<div aria-hidden className="flex pr-4">
							<span className="sticky left-0 z-10 shrink-0 bg-(--card-bg)" style={{ width: LABEL_PX, boxShadow: LABEL_EDGE }} />
							<span className="relative h-4 flex-1">
								{ticks.map((at) => (
									<span key={at} className="in-num absolute top-0.5 -translate-x-1/2 text-[9.5px] whitespace-nowrap text-(--text-disabled) first:translate-x-0" style={{ left: `${(at / span) * 100}%` }}>
										{mark(at)}
									</span>
								))}
							</span>
						</div>
					</div>
				</div>
				{mix.length ? (
					<span className="flex flex-wrap gap-x-3.5 gap-y-1 px-4">
						{mix.map((item) => (
							<span key={item.kind} className="flex items-center gap-1.5 text-[11.5px] text-(--text-tertiary)">
								<span className="size-[7px] rounded-[2px]" style={{ background: WORK[item.kind].tone }} />
								{WORK[item.kind].label}
								<span className="in-num text-(--text-secondary)">{item.count}</span>
							</span>
						))}
					</span>
				) : null}
			</div>
			<StatRow stats={stats} />
		</Card>
	);
}

/** Runs come newest first; each burst keeps that place but lists in the order it started, as the timeline and the thread's card draw it. */
function inBursts(runs: SubagentRun[]): SubagentRun[] {
	const bursts: SubagentRun[][] = [];
	for (const run of runs) {
		const burst = bursts.at(-1);
		if (burst && Date.parse(burst[0].startedAt) - Date.parse(run.startedAt) <= BATCH_MS) burst.push(run);
		else bursts.push([run]);
	}
	return bursts.flatMap((burst) => burst.reverse());
}

function RunList({ sessionId, runs, now }: { sessionId: string; runs: SubagentRun[]; now: number }) {
	const working = inBursts(runs.filter((run) => run.status === 'running'));
	const finished = inBursts(runs.filter((run) => run.status !== 'running'));
	const section = (title: string, list: SubagentRun[]) =>
		list.length ? (
			<section aria-label={title} className="flex flex-col gap-1.5">
				<h3 className="in-caption m-0 flex items-center gap-2 px-0.5">
					{title}
					<span className="in-num text-(--text-disabled)">{list.length}</span>
				</h3>
				{list.map((run) => (
					<RunCard key={run.id} run={run} now={now} onOpen={() => focusRun(sessionId, run.id)} />
				))}
			</section>
		) : null;
	return (
		<div className="flex flex-col gap-4 pt-1">
			<Overview sessionId={sessionId} runs={runs} now={now} />
			{section('Working', working)}
			{section('Finished', finished)}
		</div>
	);
}

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
	done: { label: 'Done', tone: 'success' },
	needs_confirmation: { label: 'Needs confirmation', tone: 'warning' },
	unsure: { label: 'Unsure', tone: 'warning' },
	stuck: { label: 'Stuck', tone: 'warning' },
	max_actions: { label: 'Out of actions', tone: 'warning' },
	stopped: { label: 'Stopped', tone: 'neutral' },
};

/** How sure the decision model was of an action, dimmer as it gets less sure. */
function Sureness({ p }: { p: number | null }) {
	if (p === null) return null;
	return <span className={cn('in-num shrink-0 text-[10.5px]', p >= 0.9 ? 'text-(--success-text)' : p >= 0.7 ? 'text-(--text-tertiary)' : 'text-(--warning-text)')}>{p.toFixed(2)}</span>;
}

/**
 * What the decision model did inside a step: each action with how sure it was, how it ended, and what it cost.
 * A run_script step lists the calls its program made instead, with the decision model's share if it asked any.
 */
function Decisions({ detail, live }: { detail: StepDetail; live: boolean }) {
	const outcome = detail.outcome ? OUTCOME[detail.outcome] : null;
	if (detail.script) {
		return (
			<div className="flex min-w-0 flex-col gap-1 pt-1 pb-1.5 pl-[28px]">
				{detail.actions.map((action, index) => (
					<span key={index} className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-(--text-tertiary)">
						<Icon icon={CornerDownRight} size={10} className="shrink-0 text-(--icon-disabled)" />
						<span className={cn('min-w-0 flex-1 truncate', action.failed && 'text-(--danger-text)')} title={action.what}>
							{action.what}
						</span>
					</span>
				))}
			</div>
		);
	}
	return (
		<div className="flex min-w-0 flex-col gap-1 pt-1 pb-1.5 pl-[28px]">
			{detail.actions.map((action, index) => (
				<span key={index} className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-(--text-tertiary)">
					<Icon icon={CornerDownRight} size={10} className="shrink-0 text-(--icon-disabled)" />
					<span className={cn('min-w-0 flex-1 truncate', action.failed && 'text-(--danger-text)')} title={action.what}>
						{action.what}
					</span>
					<Sureness p={action.p} />
				</span>
			))}
			<span className="flex min-w-0 items-center gap-2 pl-4">
				{outcome ? <Status tone={outcome.tone}>{outcome.label}</Status> : live ? <Status tone="accent" pulse>Driving</Status> : null}
				<Caption className="in-num ml-auto">
					Jev {detail.decisions} · {fineDollars(detail.cost)}
				</Caption>
			</span>
		</div>
	);
}

/**
 * A step in the execution timeline: the step as a sentence, a bar where it
 * fell in the run's time, and how long it took; a step the decision model
 * drove opens into its actions.
 */
function StepRow({ step, from, to, now }: { step: SubagentStep; from: number; to: number; now: number }) {
	const { icon, body } = stepBody(step);
	const start = Date.parse(step.at);
	const spent = step.durationMs ?? (step.state === 'running' ? Math.max(0, now - start) : 0);
	const tone = stepTone(step);
	return (
		<li className="flex min-w-0 flex-col border-t border-(--border-subtle) first:border-t-0">
			<span className="flex min-h-8 min-w-0 items-center gap-2.5 text-[12px] text-(--text-tertiary)">
				<span className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-(--bg-inset)">
					{step.state === 'running' ? <Spinner size={11} /> : <Icon icon={icon} size={11} style={{ color: tone }} />}
				</span>
				<span className={cn('line-clamp-2 min-w-0 flex-1 py-1 text-(--text-secondary)', step.state === 'failed' && 'text-(--danger-text)')}>{body}</span>
				<span aria-hidden className="relative h-1 w-[72px] shrink-0 rounded-full bg-(--segment-off)">
					<span
						className={cn('absolute inset-y-0 rounded-full', step.state === 'running' && 'in-pulse')}
						style={{ left: `${Math.min(100, ((start - from) / (to - from)) * 100)}%`, width: `max(${Math.min(100, (spent / (to - from)) * 100)}%, 2px)`, background: tone }}
					/>
				</span>
				<span className="in-num w-9 shrink-0 text-right text-[10.5px] text-(--text-disabled)">{step.durationMs !== null || step.state === 'running' ? took(spent) : ''}</span>
			</span>
			{step.detail ? <Decisions detail={step.detail} live={step.state === 'running'} /> : null}
		</li>
	);
}

function Transcript({ sessionId, run, now }: { sessionId: string; run: SubagentRun; now: number }) {
	const live = run.status === 'running';
	const [briefOpen, setBriefOpen] = useState(false);
	const end = useRef<HTMLDivElement>(null);
	// While it works, keep the newest step in view.
	useEffect(() => {
		if (live) end.current?.scrollIntoView({ block: 'nearest' });
	}, [live, run.steps.length, run.writing]);
	const jev = decisionsOf(run);
	const from = Date.parse(run.startedAt);
	const to = Math.max(from + 1000, from + runElapsed(run, now));
	const stats: Array<[string, string]> = [
		['Time', elapsed(runElapsed(run, now))],
		['Steps', String(run.steps.length)],
		['Tokens', tokens(run.tokens)],
		...(jev.decisions ? ([['Jev', fineDollars(jev.cost)]] as Array<[string, string]>) : []),
		['Model', run.model?.split('/').pop() ?? '—'],
	];
	return (
		<div className="flex min-h-0 flex-col gap-3">
			<div className="flex items-center gap-2">
				<IconBtn icon={ArrowLeft} size="sm" label="All agents" onClick={() => focusRun(sessionId, null)} />
				<AgentTile agent={run.agent} running={live} size={26} />
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="font-mono text-[10.5px] tracking-[0.06em] uppercase" style={{ color: lookOf(run.agent).tone }}>
						{lookOf(run.agent).label}
					</span>
					<span className="truncate text-[13px] font-medium text-(--text-primary)">{titleOf(run.prompt, run.description ?? undefined)}</span>
				</div>
				<span
					className={cn(
						'flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]',
						run.status === 'failed' ? 'border-(--danger-border) text-(--danger-text)' : live ? 'border-(--accent-border) text-(--accent-text)' : 'border-(--border-subtle) text-(--text-secondary)',
					)}
				>
					<StatusGlyph status={run.status} />
					{STATUS_LABEL[run.status]}
				</span>
				{live ? <StopRunButton sessionId={sessionId} run={run} /> : null}
			</div>

			<dl className="in-well m-0 grid divide-x divide-(--border-subtle)" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
				{stats.map(([label, value]) => (
					<div key={label} className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
						<dt className="in-caption">{label}</dt>
						<dd className="in-num m-0 truncate text-[12px] text-(--text-primary)" title={value}>
							{value}
						</dd>
					</div>
				))}
			</dl>

			<section aria-label="Brief" className="in-card overflow-hidden">
				<button
					type="button"
					aria-expanded={briefOpen}
					onClick={() => setBriefOpen(!briefOpen)}
					className="flex h-8 w-full items-center gap-2 px-3 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring-inset)"
				>
					<span className="in-caption flex-1">Brief from the agent</span>
					<Icon icon={ChevronDown} size={12} className="text-(--icon-tertiary) transition-transform" style={{ transform: briefOpen ? 'rotate(180deg)' : undefined }} />
				</button>
				<div className="border-t border-(--card-border) px-3 py-2.5 text-[12px] leading-[18px] text-(--text-secondary)">
					<p className={cn('m-0 whitespace-pre-wrap', !briefOpen && 'line-clamp-3')}>{run.prompt}</p>
				</div>
			</section>

			<section aria-label="Steps" className="flex min-h-0 flex-col gap-1.5">
				<div className="flex items-center gap-3 px-0.5">
					<h3 className="in-caption m-0 flex-1">Execution timeline</h3>
					{jev.decisions ? <Caption className="in-num">{jev.decisions} Jev decisions</Caption> : null}
				</div>
				{run.steps.length ? (
					<ol className="in-card m-0 flex list-none flex-col px-3 py-1">
						{run.steps.map((step) => (
							<StepRow key={step.id} step={step} from={from} to={to} now={now} />
						))}
					</ol>
				) : (
					<p className="m-0 px-0.5 text-[12px] text-(--text-tertiary)">{live ? 'Reading the brief…' : 'No steps.'}</p>
				)}
				{live && run.writing ? (
					<p className="agent-live-line m-0 flex gap-1.5 px-0.5 text-[12px] leading-[18px]">
						<span className="in-caption shrink-0">Writing</span>
						<span className="line-clamp-3">{run.writing}</span>
					</p>
				) : null}
			</section>

			{run.result ? (
				<section aria-label={RESULT_LABEL[run.status]} className={cn('in-card px-3.5 py-3', run.status === 'failed' && 'border-(--danger-border)')}>
					<h3 className={cn('in-caption m-0 mb-2', run.status === 'failed' && 'text-(--danger-text)')}>{RESULT_HEADING[run.status]}</h3>
					<Markdown text={run.result} />
				</section>
			) : null}
			<div ref={end} />
		</div>
	);
}

export function AgentsTab({ sessionId }: { sessionId: string }) {
	const query = useSubagentRuns(sessionId);
	const focused = useFocusedRun(sessionId);
	const runs = query.data?.runs ?? [];
	const now = useNow(runs.some((run) => run.status === 'running'));
	if (query.isPending) {
		return (
			<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				Loading the agents
			</div>
		);
	}
	if (query.isError) return <EmptyState title="Agents unavailable" body={query.error.message} />;
	if (!runs.length) {
		return (
			<EmptyState
				icon={Bot}
				title="No subagents yet"
				body="When the agent hands work to a subagent (to browse a site, explore the code or run the tests), it shows here, step by step, as it works."
			/>
		);
	}
	const run = runs.find((entry) => entry.id === focused);
	return <div className="flex min-h-0 flex-col pb-2">{run ? <Transcript sessionId={sessionId} run={run} now={now} /> : <RunList sessionId={sessionId} runs={runs} now={now} />}</div>;
}
