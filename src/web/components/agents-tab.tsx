import { ArrowLeft, Bot, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { AgentTile, lookOf, RunMeta, runElapsed, StatusGlyph, stepBody, stepTone, titleOf, useNow, useSubagentRuns } from '@/components/subagents';
import type { SubagentRun, SubagentStep } from '@/lib/api';
import { elapsed, tokens } from '@/lib/format';
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
			<span className="flex min-w-0 items-center gap-3 pl-[32px]">
				<StepTicks steps={run.steps} live={live} />
				<RunMeta run={run} now={now} className="ml-auto" />
			</span>
		</button>
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
			{section('Working', working)}
			{section('Finished', finished)}
		</div>
	);
}

/** A step in the transcript: a mark on the rail, the step as a sentence, and how long it took. */
function StepRow({ step }: { step: SubagentStep }) {
	const { icon, body } = stepBody(step);
	return (
		<li className="flex min-h-7 min-w-0 items-center gap-2.5 text-[12px] text-(--text-tertiary)">
			<span className="z-[1] inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-(--bg-inset) ring-[3px] ring-(--bg-inset)">
				{step.state === 'running' ? <Spinner size={11} /> : <Icon icon={icon} size={11} style={{ color: stepTone(step) }} />}
			</span>
			<span className={cn('min-w-0 flex-1 truncate', step.state === 'failed' && 'text-(--danger-text)')}>{body}</span>
			{step.durationMs !== null ? <span className="in-num shrink-0 text-[10.5px] text-(--text-disabled)">{elapsed(step.durationMs)}</span> : null}
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
	const stats: Array<[string, string]> = [
		['Time', elapsed(runElapsed(run, now))],
		['Steps', String(run.steps.length)],
		['Tokens', tokens(run.tokens)],
		['Model', run.model ?? '—'],
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

			<dl className="in-well m-0 grid grid-cols-4 divide-x divide-(--border-subtle)">
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
				<h3 className="in-caption m-0 px-0.5">Steps</h3>
				{run.steps.length ? (
					<ol className="relative m-0 flex list-none flex-col p-0 pl-0.5">
						<span aria-hidden className="absolute top-3 bottom-3 left-[10px] w-px bg-(--border-default)" />
						{run.steps.map((step) => (
							<StepRow key={step.id} step={step} />
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
