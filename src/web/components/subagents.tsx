import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { AppWindow, Bot, Check, ChevronRight, CircleAlert, CircleStop, FlaskConical, Monitor, Square, Telescope } from 'lucide-react';
import { type CSSProperties, type ReactNode, useContext, useEffect, useState } from 'react';
import { HoverPeek } from '@/components/hover-peek';
import { Chip } from '@/components/instrument';
import { Btn, Icon, IconBtn, Spinner } from '@/components/signal';
import { describeTool, field, toolTone } from '@/components/tool-describe';
import { api, type SubagentRun, type SubagentStep } from '@/lib/api';
import { elapsed, tokens } from '@/lib/format';
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

/** What a run is doing now, or came back with, in one plain line. */
export function runLine(run: SubagentRun | undefined, call?: Delegation): ReactNode {
	const status = run?.status ?? (call?.running ? 'running' : call?.failed ? 'failed' : 'done');
	if (status === 'running') {
		if (run?.writing) return plainLine(run.writing.split('\n').pop());
		const latest = run?.steps[run.steps.length - 1];
		return latest ? stepBody(latest).body : 'Starting…';
	}
	if (status === 'stopped') return 'Stopped by you';
	return plainLine(run?.result ?? call?.output) || (status === 'failed' ? 'Failed' : null);
}

/** What a run came back with, as plain words for a few lines of a peek. */
function answerText(text: string): string {
	return text
		.split('\n')
		.map((line) => plainLine(line))
		.filter(Boolean)
		.join(' ');
}

const STATUS_WORD: Record<SubagentRun['status'] | 'starting', string> = { running: 'Working', starting: 'Starting', done: 'Finished', failed: 'Failed', stopped: 'Stopped' };

/**
 * A subagent on hover: what kind it is and how it stands, what it is doing
 * now or what it answered, and its numbers. The brief and every step stay
 * in the Agents panel, one click away.
 */
function RunPeek({ sessionId, call, run, now, onOpen }: { sessionId: string; call: Delegation; run: SubagentRun | undefined; now: number; onOpen: () => void }) {
	const status = run?.status ?? (call.running ? 'starting' : call.failed ? 'failed' : 'done');
	const live = status === 'running' || status === 'starting';
	const look = lookOf(call.agent);
	const latest = run?.steps[run.steps.length - 1];
	const answer = live ? null : status === 'stopped' ? null : answerText(run?.result ?? call.output);
	const facts = run ? [`${run.steps.length} ${run.steps.length === 1 ? 'step' : 'steps'}`, elapsed(runElapsed(run, now)), ...(run.tokens ? [`${tokens(run.tokens)} tok`] : []), ...(run.model ? [run.model.split('/').pop()] : [])] : [];
	return (
		<>
			<div className="flex items-center gap-2">
				<AgentTile agent={call.agent} running={live} size={18} />
				<span className="font-mono text-[10.5px] tracking-[0.06em] uppercase" style={{ color: look.tone }}>
					{look.label}
				</span>
				<span className={cn('ml-auto flex items-center gap-1.5 text-[11px]', status === 'failed' ? 'text-(--danger-text)' : 'text-(--text-tertiary)')}>
					<StatusGlyph status={status} />
					{STATUS_WORD[status]}
				</span>
			</div>
			<span className="line-clamp-2 text-[13px] leading-[18px] font-medium text-(--text-primary)">{titleOf(call.prompt, call.description)}</span>
			{live ? (
				<span className="agent-live-line flex min-w-0 items-start gap-1.5 text-[12px] leading-[17px]">
					{latest && !run?.writing ? <Icon icon={stepBody(latest).icon} size={12} className="mt-[2px] shrink-0" /> : null}
					<span className="line-clamp-2 min-w-0">{runLine(run, call)}</span>
				</span>
			) : answer ? (
				<p className={cn('m-0 line-clamp-4 text-[12px] leading-[17px] text-pretty', status === 'failed' ? 'text-(--danger-text)' : 'text-(--text-secondary)')}>{answer}</p>
			) : status === 'stopped' ? (
				<p className="m-0 text-[12px] text-(--text-tertiary)">Stopped by you</p>
			) : null}
			{facts.length ? <span className="in-num truncate text-[11px] text-(--text-tertiary)">{facts.join(' · ')}</span> : null}
			<div className="flex items-center gap-1.5 border-t border-(--border-subtle) pt-2.5">
				<Btn size="xs" variant="secondary" icon={ChevronRight} onClick={onOpen}>
					Open in Agents
				</Btn>
				<span className="flex-1" />
				{run?.status === 'running' ? <StopRunButton sessionId={sessionId} run={run} /> : null}
			</div>
		</>
	);
}

/**
 * One subagent in the thread, on one line: how it stands, what it was asked
 * to do, its kind, and its steps and time as chips; while it works a second
 * line says what it is doing. Resting on it shows the rest; clicking opens
 * it in the Agents panel.
 */
function AgentRow({ sessionId, call, run, now }: { sessionId: string; call: Delegation; run: SubagentRun | undefined; now: number }) {
	const showPanel = useContext(ShowPanel);
	// Without a run (one from before Anton kept them, or a call that never reached a subagent) the call's own state and answer tell it.
	const status = run?.status ?? (call.running ? 'starting' : call.failed ? 'failed' : 'done');
	const live = status === 'running' || status === 'starting';
	const look = lookOf(call.agent);
	const latest = run?.steps[run.steps.length - 1];
	const stoppable = run?.status === 'running';
	const open = () => {
		focusRun(sessionId, run?.id ?? null);
		showPanel('Agents');
	};
	return (
		<div className="group/agent flex w-full min-w-0 items-center hover:bg-(--bg-hover)">
			<HoverPeek content={<RunPeek sessionId={sessionId} call={call} run={run} now={now} onOpen={open} />}>
				<button
					type="button"
					onClick={open}
					className={cn('flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-2 pl-3 text-left outline-none focus-visible:shadow-(--focus-ring-inset)', stoppable ? 'pr-1' : 'pr-3')}
				>
					<span className="flex min-h-5 min-w-0 items-center gap-2">
						<span className="inline-flex w-3.5 shrink-0 justify-center">
							<StatusGlyph status={status} />
						</span>
						<span className="min-w-0 truncate text-[12.5px] text-(--text-primary)">{titleOf(call.prompt, call.description)}</span>
						<Chip icon={look.icon} iconColor={look.tone}>
							{look.label}
						</Chip>
						{status === 'failed' ? <Chip tone="danger">Failed</Chip> : status === 'stopped' ? <Chip>Stopped</Chip> : null}
						<span className="flex-1" />
						{run ? (
							<span className="in-num hidden shrink-0 text-[11px] text-(--text-tertiary) sm:inline">
								{run.steps.length} {run.steps.length === 1 ? 'step' : 'steps'}
							</span>
						) : null}
						{run ? <span className={cn('in-num w-12 shrink-0 text-right text-[11px]', live ? 'text-(--accent-text)' : 'text-(--text-tertiary)')}>{elapsed(runElapsed(run, now))}</span> : null}
					</span>
					{live ? (
						<span className="agent-live-line flex min-w-0 items-center gap-1.5 pl-[22px] text-[11.5px]">
							{latest && !run?.writing ? <Icon icon={stepBody(latest).icon} size={11} className="shrink-0" /> : null}
							<span className="min-w-0 truncate">{runLine(run, call)}</span>
						</span>
					) : null}
				</button>
			</HoverPeek>
			{stoppable ? <StopRunButton sessionId={sessionId} run={run} className="mr-2 shrink-0" /> : null}
		</div>
	);
}

/**
 * The subagents a turn handed work to, in place of plain "Delegated to"
 * steps: one card, a line each. How they ran together, their lanes and
 * every step live in the Agents panel; this says only who did what.
 */
export function AgentsCard({ sessionId, calls }: { sessionId: string; calls: Delegation[] }) {
	const runs = useSubagentRuns(sessionId).data?.runs ?? [];
	const matched = calls.map((call) => ({ call, run: runFor(runs, call) }));
	const working = matched.some(({ call, run }) => (run ? run.status === 'running' : call.running));
	const now = useNow(working);
	return (
		<section
			aria-label={calls.length === 1 ? '1 agent on this reply' : `${calls.length} agents on this reply`}
			className="flex flex-col divide-y divide-(--border-subtle) overflow-hidden rounded-[12px] border border-(--card-border) bg-(--card-bg) shadow-(--card-highlight)"
		>
			{matched.map(({ call, run }) => (
				<AgentRow key={call.toolCallId} sessionId={sessionId} call={call} run={run} now={now} />
			))}
		</section>
	);
}
