import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { AppWindow, ArrowUpRight, Bot, Check, ChevronRight, CircleAlert, FlaskConical, Telescope } from 'lucide-react';
import { type CSSProperties, useContext, useEffect, useState } from 'react';
import { Icon, Spinner } from '@/components/signal';
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

export const stepTone = (step: SubagentStep) => toolTone(step.tool, step.state === 'failed');

/** Steps, time and tokens, in the instrument's mono. */
export function RunMeta({ run, now, className }: { run: SubagentRun; now: number; className?: string }) {
	const items = [`${run.steps.length} ${run.steps.length === 1 ? 'step' : 'steps'}`, elapsed(runElapsed(run, now)), ...(run.tokens ? [`${tokens(run.tokens)} tok`] : [])];
	return <span className={cn('in-num text-[11px] whitespace-nowrap text-(--text-tertiary)', className)}>{items.join(' · ')}</span>;
}

/** Running, finished, or failed, as a small glyph. */
export function StatusGlyph({ status }: { status: SubagentRun['status'] | 'starting' }) {
	if (status === 'running' || status === 'starting') return <Spinner size={11} />;
	if (status === 'failed') return <Icon icon={CircleAlert} size={12} className="text-(--danger-text)" />;
	return <Icon icon={Check} size={12} className="text-(--success-text)" />;
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

/** One subagent in the thread: who, what for, how far, and what it is doing now; opens it in the Agents panel. */
function DelegationRow({ sessionId, call, run, now }: { sessionId: string; call: Delegation; run: SubagentRun | undefined; now: number }) {
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
		: plainLine(run?.result ?? call.output) || (status === 'failed' ? 'Failed' : null);
	return (
		<button
			type="button"
			onClick={() => {
				focusRun(sessionId, run?.id ?? null);
				showPanel('Agents');
			}}
			className="group/agent flex w-full min-w-0 items-start gap-2.5 px-3 py-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring-inset)"
		>
			<AgentTile agent={call.agent} running={live} />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-2">
					<span className="font-mono text-[10.5px] tracking-[0.06em] uppercase" style={{ color: lookOf(call.agent).tone }}>
						{lookOf(call.agent).label}
					</span>
					<span className="min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)">{titleOf(call.prompt, call.description)}</span>
					{run ? <RunMeta run={run} now={now} className="hidden sm:inline" /> : null}
					<StatusGlyph status={status} />
				</span>
				{detail ? (
					<span className={cn('flex min-w-0 items-center gap-1.5 truncate text-[11.5px]', status === 'failed' ? 'text-(--danger-text)' : 'text-(--text-tertiary)', live && 'agent-live-line')}>
						{live && latest ? <Icon icon={stepBody(latest).icon} size={11} className="shrink-0" /> : null}
						<span className="min-w-0 truncate">{detail}</span>
					</span>
				) : null}
			</span>
			<Icon icon={ChevronRight} size={12} className="mt-1 shrink-0 text-(--icon-disabled) group-hover/agent:text-(--icon-secondary)" />
		</button>
	);
}

/**
 * The subagents a turn handed work to, in place of plain "Delegated to" steps:
 * one live row each, and a link to watch them in the Agents panel.
 */
export function AgentsCard({ sessionId, calls }: { sessionId: string; calls: Delegation[] }) {
	const runs = useSubagentRuns(sessionId).data?.runs ?? [];
	const matched = calls.map((call) => ({ call, run: runFor(runs, call) }));
	const working = matched.filter(({ call, run }) => (run ? run.status === 'running' : call.running)).length;
	const failed = matched.filter(({ call, run }) => (run ? run.status === 'failed' : call.failed)).length;
	const now = useNow(working > 0);
	const showPanel = useContext(ShowPanel);
	const count = `${calls.length} ${calls.length === 1 ? 'agent' : 'agents'}`;
	return (
		<div className="overflow-hidden rounded-[12px] border border-(--card-border) bg-(--card-bg) shadow-(--card-highlight)">
			<div className="flex h-9 items-center gap-2 border-b border-(--card-border) pr-1.5 pl-3">
				<span className={cn('size-1.5 shrink-0 rounded-full', working ? 'in-pulse bg-(--accent-base)' : failed ? 'bg-(--danger-base)' : 'bg-(--success-base)')} />
				<span className={cn('min-w-0 flex-1 truncate text-[12px]', working ? 'text-(--text-primary)' : 'text-(--text-secondary)')}>
					{working ? `${working === calls.length ? count : `${working} of ${count}`} working` : `Ran ${count}`}
				</span>
				{failed ? <span className="in-caption text-(--danger-text)">{failed} failed</span> : null}
				<button
					type="button"
					onClick={() => {
						focusRun(sessionId, null);
						showPanel('Agents');
					}}
					className="inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11px] text-(--text-tertiary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
				>
					Agents
					<Icon icon={ArrowUpRight} size={11} />
				</button>
			</div>
			<div className="flex flex-col divide-y divide-(--border-subtle)">
				{matched.map(({ call, run }) => (
					<DelegationRow key={call.toolCallId} sessionId={sessionId} call={call} run={run} now={now} />
				))}
			</div>
		</div>
	);
}
