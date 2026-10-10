import { ArrowLeft, Bot, ChevronDown, CornerDownRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { Card, Caption, StatRow, Status, type Tone, Well } from '@/components/instrument';
import { AgentTile, decisionsOf, Lane, lookOf, plainLine, RunMeta, runElapsed, spanOf, StatusGlyph, stepBody, stepTone, titleOf, useNow, useSubagentRuns } from '@/components/subagents';
import type { StepDetail, SubagentRun, SubagentStep } from '@/lib/api';
import { elapsed, fineDollars, tokens } from '@/lib/format';
import { cn } from '@/lib/utils';
import { focusRun, useFocusedRun } from '@/lib/workspace';

/*
 * The Agents panel: every piece of work the agent handed to a subagent, live.
 * The list shows who is working and what each finished with; a run opens into
 * its transcript: the brief, each step as it happens, and the answer.
 */

const STATUS_LABEL: Record<SubagentRun['status'], string> = { running: 'Working', done: 'Finished', failed: 'Failed' };

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
	const headline = live ? (run.writing ? plainLine(run.writing.split('\n').pop()) : latest ? stepBody(latest).body : null) : plainLine(run.result);
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

/** A round step for a time axis about four ticks long. */
function tickStep(totalMs: number): number {
	const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((seconds) => seconds * 1000);
	return steps.find((step) => totalMs / step <= 4) ?? steps[steps.length - 1];
}

/**
 * The panel's summary: who is working, steps, tokens and what the decision
 * model spent, over the latest burst of runs drawn as lanes on one time axis.
 */
function Overview({ sessionId, runs, now }: { sessionId: string; runs: SubagentRun[]; now: number }) {
	const working = runs.filter((run) => run.status === 'running').length;
	const failed = runs.filter((run) => run.status === 'failed').length;
	const newest = Math.max(...runs.map((run) => Date.parse(run.startedAt)));
	const batch = runs.filter((run) => Date.parse(run.startedAt) >= newest - BATCH_MS).slice(0, 8).reverse();
	const span = spanOf(batch, now);
	const step = tickStep(span.to - span.from);
	const ticks = Array.from({ length: Math.floor((span.to - span.from) / step) + 1 }, (_, index) => index * step);
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
			<div className="flex flex-col gap-2 px-4 pb-3.5">
				<div className="flex items-center gap-3">
					<Caption className="flex-1">{batch.length === runs.length ? 'Timeline' : 'Latest runs'}</Caption>
					<Caption className="in-num">{elapsed(span.to - span.from)}</Caption>
				</div>
				<Well grid className="flex flex-col gap-2.5 px-3 pt-3 pb-2">
					{batch.map((run) => (
						<button
							key={run.id}
							type="button"
							title={titleOf(run.prompt, run.description ?? undefined)}
							onClick={() => focusRun(sessionId, run.id)}
							className="flex min-w-0 items-center gap-2.5 rounded-[4px] text-left outline-none focus-visible:shadow-(--focus-ring)"
						>
							<span className="w-[58px] shrink-0 truncate font-mono text-[10px] tracking-[0.06em] uppercase" style={{ color: lookOf(run.agent).tone }}>
								{lookOf(run.agent).label}
							</span>
							<Lane run={run} now={now} {...span} />
						</button>
					))}
					<span aria-hidden className="relative ml-[68px] h-4">
						{ticks.map((at) => (
							<span key={at} className="in-num absolute top-0 -translate-x-1/2 text-[9.5px] text-(--text-disabled)" style={{ left: `${(at / (span.to - span.from)) * 100}%` }}>
								{elapsed(at)}
							</span>
						))}
					</span>
				</Well>
			</div>
			<StatRow stats={stats} />
		</Card>
	);
}

function RunList({ sessionId, runs, now }: { sessionId: string; runs: SubagentRun[]; now: number }) {
	const working = runs.filter((run) => run.status === 'running');
	const finished = runs.filter((run) => run.status !== 'running');
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

/** What the decision model did inside a step: each action with how sure it was, how it ended, and what it cost. */
function Decisions({ detail, live }: { detail: StepDetail; live: boolean }) {
	const outcome = detail.outcome ? OUTCOME[detail.outcome] : null;
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
	const took = step.durationMs ?? (step.state === 'running' ? Math.max(0, now - start) : 0);
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
						style={{ left: `${Math.min(100, ((start - from) / (to - from)) * 100)}%`, width: `max(${Math.min(100, (took / (to - from)) * 100)}%, 2px)`, background: tone }}
					/>
				</span>
				<span className="in-num w-9 shrink-0 text-right text-[10.5px] text-(--text-disabled)">{step.durationMs !== null || step.state === 'running' ? elapsed(took) : ''}</span>
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
				<section aria-label={run.status === 'failed' ? 'Why it failed' : 'Answer'} className={cn('in-card px-3.5 py-3', run.status === 'failed' && 'border-(--danger-border)')}>
					<h3 className={cn('in-caption m-0 mb-2', run.status === 'failed' && 'text-(--danger-text)')}>{run.status === 'failed' ? 'Why it failed' : 'Answer to the agent'}</h3>
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
