import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { AppWindow, Bot, Check, ChevronRight, CircleAlert, CircleStop, FlaskConical, Monitor, Square, Telescope } from 'lucide-react';
import { type CSSProperties, useContext, useEffect, useState } from 'react';
import { Caption, Card, CardFooter, Status } from '@/components/instrument';
import { Btn, Icon, IconBtn, Spinner } from '@/components/signal';
import { describeTool, field, toolTone } from '@/components/tool-describe';
import { api, type SubagentRun, type SubagentStep } from '@/lib/api';
import { elapsed, fineDollars, tokens } from '@/lib/format';
import { cn } from '@/lib/utils';
import { focusRun, ShowPanel } from '@/lib/workspace';

/*
 * Subagents as the user sees them: who each one is (an icon and a colour per
 * kind), how far along it is, and what it is doing now. Shared by the card in
 * the thread and the Agents panel.
 */

type Look = { icon: LucideIcon; tone: string; label: string };

const LOOKS: Record<string, Look> = {
	browser: { icon: AppWindow, tone: 'var(--data-3)', label: 'Browser' },
	computer: { icon: Monitor, tone: 'var(--data-3)', label: 'Computer' },
	explorer: { icon: Telescope, tone: 'var(--data-1)', label: 'Explorer' },
	tester: { icon: FlaskConical, tone: 'var(--data-2)', label: 'Tester' },
	'flue-general': { icon: Bot, tone: 'var(--data-5)', label: 'General' },
};

export function lookOf(agent: string): Look {
	return LOOKS[agent] ?? { icon: Bot, tone: 'var(--data-5)', label: agent.replace(/[-_]+/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase()) };
}

/** The work in a few words: the label the agent gave it, or the brief's first line. */
export function titleOf(prompt: string, description?: string): string {
	return (description?.trim() || prompt.trim().split('\n')[0] || 'Working').replace(/^#+\s*/, '');
}

/** A line of Markdown as plain words, for a one-line preview: no list marks, emphasis or links. */
export function plainLine(text: string | null | undefined): string {
	const line = (text ?? '').split('\n').find((entry) => entry.trim()) ?? '';
	return line
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
		.replace(/^#+\s*/, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[*_`]+/g, '')
		.trim();
}

/** The subagent's kind as a small tile in its colour; it breathes while the subagent works. */
export function AgentTile({ agent, running, size = 22 }: { agent: string; running?: boolean; size?: number }) {
	const look = lookOf(agent);
	const style = {
		width: size,
		height: size,
		color: look.tone,
		background: `color-mix(in oklab, ${look.tone} 14%, transparent)`,
		boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${look.tone} 38%, transparent)`,
		'--agent-tone': look.tone,
	} as CSSProperties;
	return (
		<span aria-hidden className={cn('relative inline-flex shrink-0 items-center justify-center rounded-[7px]', running && 'agent-tile--running')} style={style}>
			<Icon icon={look.icon} size={Math.round(size * 0.55)} />
		</span>
	);
}

/** The task's subagent runs, kept current from the server's announcements. */
export function useSubagentRuns(sessionId: string) {
	return useQuery({ queryKey: ['subagents', sessionId], queryFn: () => api.subagents(sessionId) });
}

/** The time now, ticking each second while `on`, so a running subagent's elapsed time moves. */
export function useNow(on: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!on) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [on]);
	return now;
}

export function runElapsed(run: SubagentRun, now: number): number {
	return run.durationMs ?? Math.max(0, now - Date.parse(run.startedAt));
}

/** A step as the thread would describe it. */
export function stepBody(step: SubagentStep) {
	return describeTool({ toolName: step.tool, input: step.input, state: step.state === 'failed' ? 'output-error' : step.state === 'done' ? 'output-available' : 'input-available' });
}

export type WorkKind = 'read' | 'search' | 'run' | 'edit' | 'browse' | 'other';

/** The kinds of work a subagent's steps add up to: reading and searching quiet greys, doing things lit in colour. */
export const WORK: Record<WorkKind, { label: string; doing: string; tone: string }> = {
	read: { label: 'Read', doing: 'reading', tone: 'var(--neutral-300)' },
	search: { label: 'Searched', doing: 'searching', tone: 'var(--neutral-500)' },
	run: { label: 'Ran', doing: 'running commands', tone: 'var(--data-1)' },
	edit: { label: 'Edited', doing: 'editing', tone: 'var(--data-2)' },
	browse: { label: 'Browsed', doing: 'browsing', tone: 'var(--data-3)' },
	other: { label: 'Other', doing: 'other tools', tone: 'var(--data-5)' },
};

export function workKind(tool: string): WorkKind {
	if (tool === 'read' || tool === 'read_file') return 'read';
	if (['grep', 'search_code', 'glob', 'list_files'].includes(tool)) return 'search';
	if (tool === 'bash' || tool === 'run_script') return 'run';
	if (tool === 'edit' || tool === 'write') return 'edit';
	if (tool === 'browser' || tool === 'screenshot' || tool === 'computer') return 'browse';
	return 'other';
}

/** A step's colour: its kind of work, or red when it failed. */
export const stepTone = (step: SubagentStep) => (step.state === 'failed' ? toolTone(step.tool, true) : WORK[workKind(step.tool)].tone);

/** Steps, time and tokens, in the instrument's mono. */
export function RunMeta({ run, now, className }: { run: SubagentRun; now: number; className?: string }) {
	const items = [`${run.steps.length} ${run.steps.length === 1 ? 'step' : 'steps'}`, elapsed(runElapsed(run, now)), ...(run.tokens ? [`${tokens(run.tokens)} tok`] : [])];
	return <span className={cn('in-num text-[11px] whitespace-nowrap text-(--text-tertiary)', className)}>{items.join(' · ')}</span>;
}

/** Running, finished, stopped or failed, as a small glyph. */
export function StatusGlyph({ status }: { status: SubagentRun['status'] | 'starting' }) {
	if (status === 'running' || status === 'starting') return <Spinner size={11} />;
	if (status === 'failed') return <Icon icon={CircleAlert} size={12} className="text-(--danger-text)" />;
	if (status === 'stopped') return <Icon icon={CircleStop} size={12} className="text-(--text-tertiary)" />;
	return <Icon icon={Check} size={12} className="text-(--success-text)" />;
}

/**
 * Stops one subagent and lets the rest of the reply go on: the agent is told
 * what it had done and carries on, reading any message that waited for it.
 */
export function useStopRun(sessionId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (runId: string) => api.stopSubagent(sessionId, runId),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['subagents', sessionId] }),
	});
}

/** A small Stop for one running subagent. */
export function StopRunButton({ sessionId, run, className }: { sessionId: string; run: SubagentRun; className?: string }) {
	const stop = useStopRun(sessionId);
	const label = `Stop the ${lookOf(run.agent).label.toLowerCase()} agent`;
	return (
		<IconBtn
			icon={Square}
			size="sm"
			label={stop.isError ? `${label}: ${stop.error.message}` : label}
			disabled={stop.isPending || stop.isSuccess}
			className={className}
			onClick={(event) => {
				event.stopPropagation();
				stop.mutate(run.id);
			}}
		/>
	);
}

/** A thread `task` call: what the agent asked, and the run it started, once the server has it. */
export type Delegation = { toolCallId: string; agent: string; prompt: string; description: string; running: boolean; failed: boolean; output: string };

/** The run a task call started: by its call id when the runtime gave one, else by who was asked what. */
export function runFor(runs: SubagentRun[], call: Delegation): SubagentRun | undefined {
	return runs.find((run) => run.toolCallId === call.toolCallId) ?? runs.find((run) => run.agent === call.agent && run.prompt === call.prompt);
}

/** What a finished task call answered, as text. */
function outputOf(part: { output?: unknown; errorText?: string }): string {
	if (part.errorText) return part.errorText;
	if (typeof part.output === 'string') return part.output;
	const content = (part.output as { content?: Array<{ text?: unknown }> } | undefined)?.content;
	return Array.isArray(content) ? content.map((item) => (typeof item.text === 'string' ? item.text : '')).join('\n') : '';
}

export function delegationOf(part: { toolCallId: string; input: unknown; state: string; output?: unknown; errorText?: string }): Delegation {
	return {
		toolCallId: part.toolCallId,
		agent: field(part.input, 'agent') || 'flue-general',
		prompt: field(part.input, 'prompt'),
		description: field(part.input, 'description'),
		running: part.state === 'input-available' || part.state === 'input-streaming',
		failed: part.state === 'output-error',
		output: outputOf(part),
	};
}

/** When a run ended, or now while it works. */
export function runEnd(run: SubagentRun, now: number): number {
	return Date.parse(run.startedAt) + runElapsed(run, now);
}

/** What the decision model did across a run's steps: how many questions it answered and what they cost. */
export function decisionsOf(run: SubagentRun): { decisions: number; cost: number } {
	return run.steps.reduce((sum, step) => ({ decisions: sum.decisions + (step.detail?.decisions ?? 0), cost: sum.cost + (step.detail?.cost ?? 0) }), { decisions: 0, cost: 0 });
}

/** The time window a set of runs spans, for lanes that share one axis. */
export function spanOf(runs: SubagentRun[], now: number): { from: number; to: number } {
	if (!runs.length) return { from: now, to: now };
	const from = Math.min(...runs.map((run) => Date.parse(run.startedAt)));
	const to = Math.max(...runs.map((run) => runEnd(run, now)));
	return { from, to: Math.max(to, from + 1000) };
}

const share = (at: number, from: number, to: number) => `${Math.min(100, Math.max(0, ((at - from) / (to - from)) * 100))}%`;

/**
 * A run as a bar on a shared time axis: where it started and how long it ran,
 * a notch where each step began, sweeping while it works. Runs side by side
 * read as parallel lanes.
 */
export function Lane({ run, from, to, now, className }: { run: SubagentRun; from: number; to: number; now: number; className?: string }) {
	const start = Date.parse(run.startedAt);
	const end = runEnd(run, now);
	const tone = run.status === 'failed' ? 'var(--danger-base)' : run.status === 'stopped' ? 'var(--neutral-500)' : lookOf(run.agent).tone;
	return (
		<span aria-hidden className={cn('relative block h-[5px] w-full min-w-0 shrink-0 rounded-full bg-(--segment-off)', className)}>
			<span
				className={cn('absolute inset-y-0 overflow-hidden rounded-full', run.status === 'running' && 'in-sweep')}
				style={{ left: share(start, from, to), width: `max(${share(from + (end - start), from, to)}, 4px)`, background: tone, opacity: run.status === 'done' ? 0.75 : 1 }}
			>
				{run.steps.slice(1).map((step) => (
					<span key={step.id} className="absolute inset-y-0 w-px bg-(--card-bg)" style={{ left: share(Date.parse(step.at), start, Math.max(end, start + 1000)) }} />
				))}
			</span>
		</span>
	);
}

/** One subagent in the thread: who, what for, its lane, and what it is doing now; opens it in the Agents panel. */
function DelegationRow({ sessionId, call, run, now, span }: { sessionId: string; call: Delegation; run: SubagentRun | undefined; now: number; span: { from: number; to: number } }) {
	const showPanel = useContext(ShowPanel);
	// Without a run (one from before Anton kept them, or a call that never reached a subagent) the call's own state and answer tell it.
	const status = run?.status ?? (call.running ? 'starting' : call.failed ? 'failed' : 'done');
	const live = status === 'running' || status === 'starting';
	const latest = run?.steps[run.steps.length - 1];
	const detail = live
		? run?.writing
			? plainLine(run.writing.split('\n').pop())
			: latest
				? stepBody(latest).body
				: 'Starting…'
		: status === 'stopped'
			? 'Stopped by you'
			: plainLine(run?.result ?? call.output) || (status === 'failed' ? 'Failed' : null);
	const look = lookOf(call.agent);
	const stoppable = run?.status === 'running';
	return (
		<div className="group/agent flex w-full min-w-0 items-start border-t border-(--border-subtle) hover:bg-(--bg-hover)">
			<button
				type="button"
				onClick={() => {
					focusRun(sessionId, run?.id ?? null);
					showPanel('Agents');
				}}
				className={cn('flex min-w-0 flex-1 items-start gap-2.5 py-2.5 pl-4 text-left outline-none focus-visible:shadow-(--focus-ring-inset)', stoppable ? 'pr-1' : 'pr-4')}
			>
				<AgentTile agent={call.agent} running={live} />
				<span className="flex min-w-0 flex-1 flex-col gap-1.5">
					<span className="flex min-w-0 items-center gap-2">
						<span className="font-mono text-[10.5px] tracking-[0.06em] uppercase" style={{ color: look.tone }}>
							{look.label}
						</span>
						<span className="min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)">{titleOf(call.prompt, call.description)}</span>
						{run ? <RunMeta run={run} now={now} className="hidden sm:inline" /> : null}
						<StatusGlyph status={status} />
					</span>
					{run ? <Lane run={run} now={now} {...span} /> : null}
					{detail ? (
						<span className={cn('flex min-w-0 items-center gap-1.5 truncate text-[11.5px]', status === 'failed' ? 'text-(--danger-text)' : 'text-(--text-tertiary)', live && 'agent-live-line')}>
							{live && latest ? <Icon icon={stepBody(latest).icon} size={11} className="shrink-0" /> : null}
							<span className="min-w-0 truncate">{detail}</span>
						</span>
					) : null}
				</span>
				<Icon icon={ChevronRight} size={12} className="mt-1 shrink-0 text-(--icon-disabled) group-hover/agent:text-(--icon-secondary)" />
			</button>
			{stoppable ? <StopRunButton sessionId={sessionId} run={run} className="mt-2 mr-3 shrink-0" /> : null}
		</div>
	);
}

/**
 * The subagents a turn handed work to, in place of plain "Delegated to" steps:
 * a card with one live lane each on a shared time axis, so work done side by
 * side reads that way, and a footer that sums it up and opens the Agents panel.
 */
export function AgentsCard({ sessionId, calls }: { sessionId: string; calls: Delegation[] }) {
	const runs = useSubagentRuns(sessionId).data?.runs ?? [];
	const matched = calls.map((call) => ({ call, run: runFor(runs, call) }));
	const working = matched.filter(({ call, run }) => (run ? run.status === 'running' : call.running)).length;
	const failed = matched.filter(({ call, run }) => (run ? run.status === 'failed' : call.failed)).length;
	const stopped = matched.filter(({ run }) => run?.status === 'stopped').length;
	const now = useNow(working > 0);
	const showPanel = useContext(ShowPanel);
	const found = matched.flatMap(({ run }) => (run ? [run] : []));
	const span = spanOf(found, now);
	const steps = found.reduce((sum, run) => sum + run.steps.length, 0);
	const used = found.reduce((sum, run) => sum + run.tokens, 0);
	const jev = found.map(decisionsOf).reduce((sum, item) => ({ decisions: sum.decisions + item.decisions, cost: sum.cost + item.cost }), { decisions: 0, cost: 0 });
	const count = `${calls.length} ${calls.length === 1 ? 'agent' : 'agents'}`;
	const status = (
		<span className="flex shrink-0 items-center gap-3">
			{failed ? <Status tone="danger">{failed} failed</Status> : null}
			{stopped && (working || failed || stopped < calls.length) ? <Status>{stopped} stopped</Status> : null}
			{working ? (
				<Status tone="accent" pulse>
					{working === calls.length ? (calls.length === 1 ? 'Working' : 'All working') : `${working} of ${calls.length} working`}
				</Status>
			) : failed ? null : stopped === calls.length ? (
				<Status>Stopped</Status>
			) : (
				<Status tone="success">Done</Status>
			)}
		</span>
	);
	const caption = [
		found.length ? elapsed(span.to - span.from) : null,
		`${steps} ${steps === 1 ? 'step' : 'steps'}`,
		used ? `${tokens(used)} tok` : null,
		jev.decisions ? `Jev ${jev.decisions} · ${fineDollars(jev.cost)}` : null,
	].filter(Boolean);
	return (
		<Card
			as="div"
			label="Agents"
			title={working ? 'Agents' : `Ran ${count}`}
			sub={working ? `${count} on this reply` : 'this reply'}
			status={status}
			footer={
				<CardFooter caption={<Caption className="in-num">{caption.join(' · ')}</Caption>}>
					<Btn
						size="sm"
						onClick={() => {
							focusRun(sessionId, null);
							showPanel('Agents');
						}}
					>
						Open agents
					</Btn>
				</CardFooter>
			}
		>
			<div className="flex flex-col">
				{matched.map(({ call, run }) => (
					<DelegationRow key={call.toolCallId} sessionId={sessionId} call={call} run={run} now={now} span={span} />
				))}
			</div>
		</Card>
	);
}
