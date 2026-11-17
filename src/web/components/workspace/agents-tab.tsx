import { ArrowLeft, Check, ChevronDown, CircleAlert, CircleStop } from '@/lib/icons';
import { HoverCard } from 'radix-ui';
import { memo, type ReactNode, useRef, useState } from 'react';
import { AgentsArt } from '@/components/marks/illustrations';
import { Markdown } from '@/components/content/markdown';
import { EmptyState, Icon, IconBtn, Spinner } from '@/components/kit/signal';
import { Caption, SplitBar, Status, type Tone } from '@/components/kit/instrument';
import { AgentTile, decisionsOf, lookOf, runElapsed, runEnd, runLine, spanOf, StatusGlyph, stepBody, StopRunButton, stepTone, titleOf, useNow, useSubagentRuns, WORK, type WorkKind, workKind } from '@/components/thread/subagents';
import type { StepDetail, SubagentRun, SubagentStep } from '@/lib/api';
import { age, elapsed, fineDollars, tokens } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useFollowLatest } from '@/lib/use-follow-latest';
import { JumpToLatest } from '@/components/kit/jump-to-latest';
import { focusRun, useFocusedRun } from '@/lib/workspace';

const STATUS_LABEL: Record<SubagentRun['status'], string> = { running: 'Working', done: 'Finished', failed: 'Failed', stopped: 'Stopped' };

const RESULT_LABEL: Record<SubagentRun['status'], string> = { running: 'Answer', done: 'Answer', failed: 'Why it failed', stopped: 'Stopped' };
const RESULT_HEADING: Record<SubagentRun['status'], string> = { running: 'Answer to the agent', done: 'Answer to the agent', failed: 'Why it failed', stopped: 'Stopped' };

/** Runs started within this long of the newest one are drawn together, as one burst of work. */
const BATCH_MS = 10 * 60_000;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

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

export function workMix(runs: SubagentRun[]): Array<{ kind: WorkKind; count: number }> {
	const counts = new Map<WorkKind, number>();
	for (const run of runs) for (const step of run.steps) counts.set(workKind(step.tool), (counts.get(workKind(step.tool)) ?? 0) + 1);
	return [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

export function burstLine(runs: SubagentRun[], now: number): { headline: string; work: string; failed: number } {
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
	return { headline, work, failed };
}

/** A duration, in milliseconds under a second so a quick step does not read "0s". */
const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : elapsed(ms));

const mark = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

/** Drawn again only when its place or state changes; the lane's one hover card says what it was (`Lane`). */
const PhaseBar = memo(function PhaseBar({ index, left, width, tone, running }: { index: number; left: number; width: number; tone: string; running: boolean }) {
	return (
		<span
			data-step={index}
			className={cn('absolute inset-y-0 rounded-mark hover:brightness-150', running && 'in-pulse')}
			style={{ left: `${left}%`, width: `max(calc(${width}% - 1px), 2px)`, background: tone }}
		/>
	);
});

function PhaseCard({ step, run, next, from, now }: { step: SubagentStep; run: SubagentRun; next?: SubagentStep; from: number; now: number }) {
	const start = Date.parse(step.at);
	const end = next ? Date.parse(next.at) : runEnd(run, now);
	const kind = WORK[workKind(step.tool)];
	const { icon, body } = stepBody(step);
	const tool = step.durationMs ?? (step.state === 'running' ? Math.max(0, now - start) : null);
	return (
		<>
			<span className="flex items-center gap-1.5">
				<span className="size-[7px] rounded-mark" style={{ background: stepTone(step) }} />
				<span className={cn('in-caption', step.state === 'failed' ? 'text-(--bad)' : 'text-(--text-2)')}>{step.state === 'failed' ? 'Failed' : kind.label}</span>
				<span className="in-caption ml-auto">at {mark(start - from)}</span>
			</span>
			<span className="flex min-w-0 items-start gap-2 text-body leading-[18px] text-(--text)">
				<Icon icon={icon} size={13} className="mt-[2px] shrink-0 text-(--text-3)" />
				<span className="line-clamp-3 min-w-0 break-words">{body}</span>
			</span>
			<span className="in-num text-micro text-(--text-3)">
				{[tool === null ? null : `tool ${took(tool)}`, `phase ${took(Math.max(0, end - start))}`, lookOf(run.agent).label.toLowerCase()].filter(Boolean).join(' · ')}
			</span>
		</>
	);
}

/** One hover card serves the whole lane and follows the phase under the pointer, so a lane of many steps is many plain bars, not a card each. */
function Lane({ run, from, span, now }: { run: SubagentRun; from: number; span: number; now: number }) {
	const [hover, setHover] = useState<{ index: number; left: number } | null>(null);
	const step = hover ? run.steps[hover.index] : undefined;
	const at = (ms: number) => ((ms - from) / span) * 100;
	return (
		<HoverCard.Root open={Boolean(step)} onOpenChange={(open) => (open ? undefined : setHover(null))}>
			<HoverCard.Trigger asChild>
				<span
					className="relative ml-[26px] h-2.5 min-w-0 rounded-mark bg-(--bg-active)/60"
					onPointerOver={(event) => {
						const bar = (event.target as HTMLElement).closest<HTMLElement>('[data-step]');
						if (bar && Number(bar.dataset.step) !== hover?.index) setHover({ index: Number(bar.dataset.step), left: bar.offsetLeft });
					}}
					onPointerLeave={() => setHover(null)}
				>
					<span
						aria-hidden
						className="absolute inset-y-[4px] rounded-full bg-(--line-strong)"
						style={{ left: `${at(Date.parse(run.startedAt))}%`, width: `${((runEnd(run, now) - Date.parse(run.startedAt)) / span) * 100}%` }}
					/>
					{run.steps.map((entry, index) => {
						const start = Date.parse(entry.at);
						const next = run.steps[index + 1];
						const end = next ? Date.parse(next.at) : runEnd(run, now);
						return <PhaseBar key={entry.id} index={index} left={at(start)} width={((Math.max(end, start) - start) / span) * 100} tone={stepTone(entry)} running={entry.state === 'running'} />;
					})}
				</span>
			</HoverCard.Trigger>
			<HoverCard.Portal>
				{step && hover ? (
					<HoverCard.Content
						side="top"
						align="start"
						alignOffset={hover.left}
						sideOffset={8}
						collisionPadding={12}
						className="in-pop z-50 flex w-[280px] flex-col gap-1.5 px-3 py-2.5 outline-none"
					>
						<PhaseCard step={step} run={run} next={run.steps[hover.index + 1]} from={from} now={now} />
					</HoverCard.Content>
				) : null}
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

type Stat = { label: string; value: string; title?: string };

function StatWell({ stats, label }: { stats: Stat[]; label: string }) {
	return (
		<dl aria-label={label} className="in-well m-0 grid divide-x divide-(--line)" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
			{stats.map((stat) => (
				<div key={stat.label} className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
					<dt className="in-caption">{stat.label}</dt>
					<dd className="in-num m-0 truncate text-small text-(--text)" title={stat.title ?? stat.value}>
						{stat.value}
					</dd>
				</div>
			))}
		</dl>
	);
}

function Overview({ runs, latest, now }: { runs: SubagentRun[]; latest: SubagentRun[]; now: number }) {
	const line = burstLine(latest, now);
	const mix = workMix(latest);
	const jev = runs.map(decisionsOf).reduce((sum, item) => ({ decisions: sum.decisions + item.decisions, cost: sum.cost + item.cost }), { decisions: 0, cost: 0 });
	const totals: Stat[] = [
		{ label: 'Runs', value: String(runs.length) },
		{ label: 'Steps', value: String(runs.reduce((sum, run) => sum + run.steps.length, 0)) },
		{ label: 'Tokens', value: tokens(runs.reduce((sum, run) => sum + run.tokens, 0)) },
		...(jev.decisions ? [{ label: 'Jev', value: fineDollars(jev.cost), title: `${jev.decisions} decisions by Jev, the decision model that drives the browser` }] : []),
	];
	return (
		<section aria-label="Agents overview" className="flex flex-col gap-3 px-0.5">
			<div className="flex items-start gap-3">
				<span className="min-w-0 flex-1 text-body-lg leading-[20px] font-medium text-pretty text-(--text)">{line.headline}</span>
				{line.failed ? (
					<span className="pt-0.5">
						<Status tone="danger">{line.failed} failed</Status>
					</span>
				) : null}
			</div>
			{mix.length ? (
				<SplitBar label={line.work} parts={mix.map((item) => ({ key: item.kind, label: WORK[item.kind].label, value: item.count, color: WORK[item.kind].tone }))} />
			) : (
				<Caption className="tracking-normal normal-case">{line.work}</Caption>
			)}
			<StatWell stats={totals} label="Every run in this task" />
		</section>
	);
}

function RunRow({ run, from, span, now, onOpen }: { run: SubagentRun; from: number; span: number; now: number; onOpen: () => void }) {
	const live = run.status === 'running';
	const line = runLine(run);
	return (
		<div className="group/run flex min-w-0 flex-col gap-2 px-3 py-2.5 hover:bg-(--bg-hover)">
			<button type="button" onClick={onOpen} className="flex min-w-0 items-center gap-2 text-left outline-none focus-visible:shadow-(--focus)">
				<AgentTile agent={run.agent} running={live} size={18} />
				<span className="min-w-0 flex-1 truncate text-body text-(--text) group-hover/run:underline">{titleOf(run.prompt, run.description ?? undefined)}</span>
				<span className={cn('flex shrink-0 items-center gap-1.5 text-micro', run.status === 'failed' ? 'text-(--bad)' : 'text-(--text-3)')}>
					<StatusGlyph status={run.status} />
					<span className="in-num">{elapsed(runElapsed(run, now))}</span>
				</span>
			</button>
			<Lane run={run} from={from} span={span} now={now} />
			{line ? (
				<button
					type="button"
					tabIndex={-1}
					onClick={onOpen}
					className={cn('ml-[26px] truncate text-left text-small outline-none', run.status === 'failed' ? 'text-(--bad)' : 'text-(--text-3)', live && 'agent-live-line')}
				>
					{line}
				</button>
			) : null}
		</div>
	);
}

/** Runs come newest first; split into bursts, newest burst first, each listed in the order it started. */
function bursts(runs: SubagentRun[]): SubagentRun[][] {
	const out: SubagentRun[][] = [];
	for (const run of runs) {
		const burst = out.at(-1);
		if (burst && Date.parse(burst[0].startedAt) - Date.parse(run.startedAt) <= BATCH_MS) burst.push(run);
		else out.push([run]);
	}
	return out.map((burst) => burst.reverse());
}

function Burst({ sessionId, runs, label, now }: { sessionId: string; runs: SubagentRun[]; label: string; now: number }) {
	const { from, to } = spanOf(runs, now);
	return (
		<section aria-label={label} className="flex flex-col gap-1.5">
			<h3 className="in-caption m-0 flex items-center gap-2 px-0.5">
				<span className="flex-1">{label}</span>
				<span className="in-num">{elapsed(to - from)}</span>
			</h3>
			<div className="in-card flex flex-col divide-y divide-(--line) overflow-hidden">
				{runs.map((run) => (
					<RunRow key={run.id} run={run} from={from} span={to - from} now={now} onOpen={() => focusRun(sessionId, run.id)} />
				))}
			</div>
		</section>
	);
}

function RunList({ sessionId, runs, now }: { sessionId: string; runs: SubagentRun[]; now: number }) {
	const groups = bursts(runs);
	return (
		<div className="flex flex-col gap-4 pt-1">
			<Overview runs={runs} latest={groups[0] ?? []} now={now} />
			{groups.map((burst, index) => {
				const ago = age(burst[0].startedAt, now);
				return <Burst key={burst[0].id} sessionId={sessionId} runs={burst} label={index === 0 ? 'Latest' : ago === 'now' ? 'Earlier' : `${ago} ago`} now={now} />;
			})}
		</div>
	);
}

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
	done: { label: 'Done', tone: 'success' },
	needs_confirmation: { label: 'Needs confirmation', tone: 'attention' },
	unsure: { label: 'Unsure', tone: 'warning' },
	stuck: { label: 'Stuck', tone: 'warning' },
	max_actions: { label: 'Out of actions', tone: 'warning' },
	stopped: { label: 'Stopped', tone: 'neutral' },
};

function Sureness({ p }: { p: number | null }) {
	if (p === null) return null;
	return <span className={cn('in-num shrink-0 text-micro', p >= 0.9 ? 'text-(--ok)' : p >= 0.7 ? 'text-(--text-3)' : 'text-(--warn)')}>{p.toFixed(2)}</span>;
}

/** The first few calls, the rest a click away, so one busy script does not push the steps after it out of view. */
function ScriptCalls({ detail }: { detail: StepDetail }) {
	const [all, setAll] = useState(false);
	const shown = all ? detail.actions : detail.actions.slice(0, SCRIPT_SHOWN);
	const hidden = detail.actions.length - shown.length;
	return (
		<div className="flex min-w-0 flex-col gap-0.5 pl-5">
			{shown.map((action, index) => (
				<span key={index} className={cn('min-w-0 truncate font-mono text-nano leading-4', action.failed ? 'text-(--bad)' : 'text-(--text-3)')} title={action.what}>
					{action.what}
				</span>
			))}
			{hidden > 0 || all ? (
				<button type="button" onClick={() => setAll(!all)} className="self-start rounded-inner text-micro text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
					{all ? 'Show fewer calls' : `${hidden} more call${hidden === 1 ? '' : 's'}`}
				</button>
			) : null}
		</div>
	);
}

const SCRIPT_SHOWN = 4;

function Decisions({ detail, live }: { detail: StepDetail; live: boolean }) {
	const outcome = detail.outcome ? OUTCOME[detail.outcome] : null;
	return (
		<div className="flex min-w-0 flex-col gap-1 pl-5">
			{detail.actions.map((action, index) => (
				<span key={index} className="flex min-w-0 items-center gap-1.5 text-small text-(--text-3)">
					<span className={cn('min-w-0 flex-1 truncate', action.failed && 'text-(--bad)')} title={action.what}>
						{action.what}
					</span>
					<Sureness p={action.p} />
				</span>
			))}
			<span className="flex min-w-0 items-center gap-2">
				{outcome ? <Status tone={outcome.tone}>{outcome.label}</Status> : live ? <Status tone="accent" pulse>Driving</Status> : null}
				<Caption className="in-num ml-auto">
					Jev {detail.decisions} · {fineDollars(detail.cost)}
				</Caption>
			</span>
		</div>
	);
}

/** A pause between steps shorter than this is not worth a line of its own. */
const THOUGHT_MS = 2000;

const SPINE_ROW = 'grid grid-cols-[36px_16px_minmax(0,1fr)] gap-x-2';

/** Ringed in the panel's own fill so the spine stops at it. */
function Node({ tone, live, ring, children }: { tone: string; live?: boolean; ring?: boolean; children?: ReactNode }) {
	return (
		<span className="relative z-[1] flex h-5 items-center justify-center">
			<span
				className={cn('flex items-center justify-center rounded-full shadow-[0_0_0_3px_var(--bg-panel)]', live && 'in-pulse', children ? 'size-4' : 'size-2.5')}
				style={ring ? { boxShadow: `inset 0 0 0 1.5px ${tone}, 0 0 0 3px var(--bg-panel)`, background: 'var(--bg-panel)' } : { background: tone }}
			>
				{children}
			</span>
		</span>
	);
}

function Ribbon({ run, from, to, now, lit, onLight, onPick }: { run: SubagentRun; from: number; to: number; now: number; lit: number | null; onLight: (index: number | null) => void; onPick: (index: number) => void }) {
	const span = to - from;
	const at = (ms: number) => Math.max(0, Math.min(100, ((ms - from) / span) * 100));
	return (
		<div className="flex flex-col gap-1">
			<div aria-hidden className="relative h-3.5 overflow-hidden rounded-mark bg-(--bg-active)/60" onPointerLeave={() => onLight(null)}>
				{run.steps.map((step, index) => {
					const start = Date.parse(step.at);
					const next = run.steps[index + 1];
					const end = Math.max(start, next ? Date.parse(next.at) : runEnd(run, now));
					const tool = step.durationMs ?? (step.state === 'running' ? Math.max(0, now - start) : end - start);
					const tone = stepTone(step);
					const width = at(end) - at(start);
					const solid = end > start ? Math.min(100, (tool / (end - start)) * 100) : 100;
					return (
						<span
							key={step.id}
							onPointerEnter={() => onLight(index)}
							onClick={() => onPick(index)}
							className={cn('absolute inset-y-0 cursor-pointer transition-opacity duration-(--t-fast)', lit !== null && lit !== index && 'opacity-40', step.state === 'running' && 'in-pulse')}
							style={{ left: `${at(start)}%`, width: `max(calc(${width}% - 1px), 2px)`, background: `linear-gradient(to right, ${tone} ${solid}%, color-mix(in srgb, ${tone} 28%, transparent) ${solid}%)` }}
						/>
					);
				})}
			</div>
			<div aria-hidden className="in-num flex justify-between text-nano text-(--text-4)">
				<span>0:00</span>
				<span>{mark(span / 2)}</span>
				<span>{mark(span)}</span>
			</div>
		</div>
	);
}

function SpineStep({ step, index, since, from, now, lit, onLight }: { step: SubagentStep; index: number; since: number; from: number; now: number; lit: boolean; onLight: (index: number | null) => void }) {
	const { icon, body } = stepBody(step);
	const start = Date.parse(step.at);
	const spent = step.durationMs ?? (step.state === 'running' ? Math.max(0, now - start) : 0);
	const thought = start - since;
	const tone = stepTone(step);
	const failed = step.state === 'failed';
	return (
		<li data-spine-step={index} className="flex min-w-0 flex-col" onPointerEnter={() => onLight(index)} onPointerLeave={() => onLight(null)}>
			{thought >= THOUGHT_MS ? (
				<span className={cn(SPINE_ROW, 'min-h-6 items-center')}>
					<span />
					<span />
					<span className="in-num text-micro text-(--text-4)">thought {took(thought)}</span>
				</span>
			) : null}
			<span className={cn(SPINE_ROW, 'rounded-control py-1 transition-colors duration-(--t-fast)', lit && 'bg-(--bg-hover)')}>
				<span className="in-num pt-0.5 text-right text-micro leading-4 text-(--text-4)">{mark(start - from)}</span>
				<Node tone={tone} live={step.state === 'running'} />
				<span className="flex min-w-0 flex-col gap-1">
					<span className="flex min-w-0 items-start gap-2">
						<Icon icon={icon} size={12} className={cn('mt-[3px] shrink-0', failed ? 'text-(--bad)' : 'text-(--text-4)')} />
						<span className={cn('line-clamp-2 min-w-0 flex-1 text-small leading-[18px] break-words', failed ? 'text-(--bad)' : 'text-(--text-2)')}>{body}</span>
						<span className="in-num shrink-0 pt-px text-micro leading-4 text-(--text-4)">
							{step.state === 'running' ? <Spinner size={10} /> : step.durationMs !== null ? took(spent) : ''}
						</span>
					</span>
					{step.detail ? step.detail.script ? <ScriptCalls detail={step.detail} /> : <Decisions detail={step.detail} live={step.state === 'running'} /> : null}
				</span>
			</span>
		</li>
	);
}

function Transcript({ sessionId, run, now }: { sessionId: string; run: SubagentRun; now: number }) {
	const live = run.status === 'running';
	const [briefOpen, setBriefOpen] = useState(false);
	const [lit, setLit] = useState<number | null>(null);
	const root = useRef<HTMLDivElement>(null);
	// While it works, keep the newest step in view, unless you scroll up to read.
	const { following, follow } = useFollowLatest(root, { enabled: live, reset: run.id });
	const jev = decisionsOf(run);
	const from = Date.parse(run.startedAt);
	const to = Math.max(from + 1000, from + runElapsed(run, now));
	const look = lookOf(run.agent);
	const facts = [
		{ label: 'Time', value: elapsed(runElapsed(run, now)) },
		{ label: 'Steps', value: String(run.steps.length) },
		{ label: 'Tokens', value: tokens(run.tokens) },
		...(jev.decisions ? [{ label: 'Jev', value: fineDollars(jev.cost) }] : []),
		{ label: 'Model', value: run.model?.split('/').pop() ?? '—' },
	];
	const pick = (index: number) => root.current?.querySelector(`[data-spine-step="${index}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	const failed = run.status === 'failed';
	const endTone = failed ? 'var(--bad)' : run.status === 'stopped' ? 'var(--text-4)' : 'var(--ok)';
	return (
		<div ref={root} className="flex min-h-0 flex-col gap-4">
			<div className="flex items-center gap-2">
				<IconBtn icon={ArrowLeft} size="sm" label="All agents" onClick={() => focusRun(sessionId, null)} />
				<AgentTile agent={run.agent} running={live} size={26} />
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="text-micro font-medium" style={{ color: look.tone }}>
						{look.label}
					</span>
					<span className="truncate text-body font-medium text-(--text)">{titleOf(run.prompt, run.description ?? undefined)}</span>
				</div>
				<span
					className={cn(
						'flex h-[18px] shrink-0 items-center gap-1 rounded-inner px-1.5 text-micro font-medium',
						failed ? 'bg-(--bad-soft) text-(--bad)' : live ? 'bg-(--accent-soft) text-(--accent-text)' : 'bg-(--bg-active) text-(--text-2)',
					)}
				>
					<StatusGlyph status={run.status} />
					{STATUS_LABEL[run.status]}
				</span>
				{live ? <StopRunButton sessionId={sessionId} run={run} /> : null}
			</div>

			<section aria-label="This run" className="flex flex-col gap-2">
				<dl className="m-0 flex flex-wrap items-baseline gap-x-4 gap-y-1">
					{facts.map((fact) => (
						<div key={fact.label} className="flex min-w-0 items-baseline gap-1.5">
							<dt className="in-caption">{fact.label}</dt>
							<dd className="in-num m-0 truncate text-small text-(--text)" title={fact.value}>
								{fact.value}
							</dd>
						</div>
					))}
				</dl>
				{run.steps.length ? <Ribbon run={run} from={from} to={to} now={now} lit={lit} onLight={setLit} onPick={pick} /> : null}
			</section>

			<div className="relative flex min-w-0 flex-col gap-1">
				<span aria-hidden className="absolute top-3 bottom-3 left-[51px] w-px bg-(--line-strong)" />

				<section aria-label="Brief" className={SPINE_ROW}>
					<span className="in-num pt-0.5 text-right text-micro leading-4 text-(--text-4)">0:00</span>
					<Node tone={look.tone} ring />
					<div className="flex min-w-0 flex-col gap-1 pb-2">
						<button type="button" aria-expanded={briefOpen} onClick={() => setBriefOpen(!briefOpen)} className="flex h-5 items-center gap-1.5 self-start rounded-inner text-left outline-none focus-visible:shadow-(--focus)">
							<span className="in-caption">Brief from the agent</span>
							<Icon icon={ChevronDown} size={12} className="text-(--text-3) transition-transform" style={{ transform: briefOpen ? 'rotate(180deg)' : undefined }} />
						</button>
						<p className={cn('m-0 text-small leading-[18px] whitespace-pre-wrap text-(--text-2)', !briefOpen && 'line-clamp-3')}>{run.prompt}</p>
					</div>
				</section>

				<section aria-label="Steps" className="flex min-w-0 flex-col">
					{run.steps.length ? (
						<ol className="m-0 flex list-none flex-col gap-0.5 p-0">
							{run.steps.map((step, index) => {
								const before = run.steps[index - 1];
								const since = before ? Date.parse(before.at) + (before.durationMs ?? 0) : from;
								return <SpineStep key={step.id} step={step} index={index} since={since} from={from} now={now} lit={lit === index} onLight={setLit} />;
							})}
						</ol>
					) : (
						<p className={cn(SPINE_ROW, 'm-0')}>
							<span />
							<span />
							<span className="text-small text-(--text-3)">{live ? 'Reading the brief…' : 'No steps.'}</span>
						</p>
					)}
				</section>

				{live ? (
					<div className={cn(SPINE_ROW, 'pt-1')}>
						<span className="in-num pt-0.5 text-right text-micro leading-4 text-(--accent-text)">{mark(to - from)}</span>
						<Node tone="var(--accent)" live />
						{run.writing ? (
							<p className="agent-live-line m-0 flex gap-1.5 text-small leading-[18px]">
								<span className="in-caption shrink-0">Writing</span>
								<span className="line-clamp-3">{run.writing}</span>
							</p>
						) : (
							<span className="in-shimmer text-small leading-5">Working</span>
						)}
					</div>
				) : run.result ? (
					<section aria-label={RESULT_LABEL[run.status]} className={cn(SPINE_ROW, 'pt-1')}>
						<span className="in-num pt-0.5 text-right text-micro leading-4 text-(--text-4)">{mark(to - from)}</span>
						<Node tone={endTone}>
							<Icon icon={failed ? CircleAlert : run.status === 'stopped' ? CircleStop : Check} size={10} className="text-(--bg-panel)" />
						</Node>
						<div className={cn('in-card min-w-0 px-3.5 py-3', failed && 'shadow-[inset_0_0_0_1px_var(--bad-line)]')}>
							<h3 className={cn('in-caption m-0 mb-2', failed && 'text-(--bad)')}>{RESULT_HEADING[run.status]}</h3>
							<Markdown text={run.result} />
						</div>
					</section>
				) : null}
			</div>
			<JumpToLatest show={!following} live onJump={follow} className="-mt-3" />
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
			<div className="flex h-7 items-center gap-2 text-small text-(--text-3)">
				<Spinner size={12} />
				Loading the agents
			</div>
		);
	}
	if (query.isError) return <EmptyState title="Agents unavailable" body={query.error.message} />;
	if (!runs.length) {
		return (
			<EmptyState
				art={<AgentsArt className="w-full max-w-[360px]" />}
				title="No subagents yet"
				body="When the agent hands work to a subagent (to browse a site, explore the code or run the tests), it shows here, step by step, as it works."
			/>
		);
	}
	const run = runs.find((entry) => entry.id === focused);
	return <div className="flex min-h-0 flex-col pb-2">{run ? <Transcript sessionId={sessionId} run={run} now={now} /> : <RunList sessionId={sessionId} runs={runs} now={now} />}</div>;
}
