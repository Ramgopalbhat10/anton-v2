import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, CircleAlert, CircleStop, Square } from '@/lib/icons';
import { type ReactNode, useContext, useEffect, useState } from 'react';
import { HoverPeek } from '@/components/kit/hover-peek';
import { Chip } from '@/components/kit/instrument';
import { Btn, Icon, IconBtn, Spinner } from '@/components/kit/signal';
import { describeTool, field, toolTone } from '@/components/thread/tool-describe';
import { api } from '@/lib/api';
import type { SubagentRun, SubagentStep } from '@/lib/api/sessions';
import { elapsed, tokens } from '@/lib/format';
import { cn } from '@/lib/utils';
import { focusRun, ShowPanel } from '@/lib/workspace';
import { taskQueries } from '@/lib/task-queries';
import { type Delegation, lookOf, plainLine, runElapsed, runFor, titleOf, WORK, workKind } from '@/lib/subagents';

export function AgentTile({ agent, running, size = 22 }: { agent: string; running?: boolean; size?: number }) {
	const look = lookOf(agent);
	// Just the role's glyph in the role's colour, no tile behind it: the colour is what tells roles apart.
	return (
		<span aria-hidden className={cn('relative inline-flex shrink-0 items-center justify-center', running && 'agent-tile--running')} style={{ width: size, height: size, color: look.tone }}>
			<Icon icon={look.icon} size={Math.round(size * 0.72)} />
		</span>
	);
}

export function useSubagentRuns(sessionId: string) {
	return useQuery(taskQueries.subagents(sessionId));
}

export function useNow(on: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!on) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [on]);
	return now;
}

export function stepBody(step: SubagentStep) {
	return describeTool({ toolName: step.tool, input: step.input, state: step.state === 'failed' ? 'output-error' : step.state === 'done' ? 'output-available' : 'input-available' });
}

export const stepTone = (step: SubagentStep) => (step.state === 'failed' ? toolTone(step.tool, true) : WORK[workKind(step.tool)].tone);

export function StatusGlyph({ status }: { status: SubagentRun['status'] | 'starting' }) {
	if (status === 'running' || status === 'starting') return <Spinner size={11} />;
	if (status === 'failed') return <Icon icon={CircleAlert} size={12} className="text-(--bad)" />;
	if (status === 'stopped') return <Icon icon={CircleStop} size={12} className="text-(--text-3)" />;
	return <Icon icon={Check} size={12} className="text-(--ok)" />;
}

/** The agent is told what it had done and carries on, reading any message that waited for it. */
export function useStopRun(sessionId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (runId: string) => api.stopSubagent(sessionId, runId),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['subagents', sessionId] }),
	});
}

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

function answerText(text: string): string {
	return text
		.split('\n')
		.map((line) => plainLine(line))
		.filter(Boolean)
		.join(' ');
}

const STATUS_WORD: Record<SubagentRun['status'] | 'starting', string> = { running: 'Working', starting: 'Starting', done: 'Finished', failed: 'Failed', stopped: 'Stopped' };

/** The brief and every step stay in the Agents panel, one click away. */
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
				<span className="text-micro font-medium" style={{ color: look.tone }}>
					{look.label}
				</span>
				<span className={cn('ml-auto flex items-center gap-1.5 text-micro', status === 'failed' ? 'text-(--bad)' : 'text-(--text-3)')}>
					<StatusGlyph status={status} />
					{STATUS_WORD[status]}
				</span>
			</div>
			<span className="line-clamp-2 text-body leading-[18px] font-medium text-(--text)">{titleOf(call.prompt, call.description)}</span>
			{live ? (
				<span className="agent-live-line flex min-w-0 items-start gap-1.5 text-small leading-[17px]">
					{latest && !run?.writing ? <Icon icon={stepBody(latest).icon} size={12} className="mt-[2px] shrink-0" /> : null}
					<span className="line-clamp-2 min-w-0">{runLine(run, call)}</span>
				</span>
			) : answer ? (
				<p className={cn('m-0 line-clamp-4 text-small leading-[17px] text-pretty', status === 'failed' ? 'text-(--bad)' : 'text-(--text-2)')}>{answer}</p>
			) : status === 'stopped' ? (
				<p className="m-0 text-small text-(--text-3)">Stopped by you</p>
			) : null}
			{facts.length ? <span className="in-num truncate text-micro text-(--text-3)">{facts.join(' · ')}</span> : null}
			<div className="flex items-center gap-1.5 border-t border-(--line) pt-2.5">
				<Btn size="xs" variant="secondary" icon={ChevronRight} onClick={onOpen}>
					Open in Agents
				</Btn>
				<span className="flex-1" />
				{run?.status === 'running' ? <StopRunButton sessionId={sessionId} run={run} /> : null}
			</div>
		</>
	);
}

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
					className={cn('flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-2 pl-3 text-left outline-none focus-visible:shadow-(--focus-inset)', stoppable ? 'pr-1' : 'pr-3')}
				>
					<span className="flex min-h-5 min-w-0 items-center gap-2">
						<span className="inline-flex w-3.5 shrink-0 justify-center">
							<StatusGlyph status={status} />
						</span>
						<span className="min-w-0 truncate text-body text-(--text)">{titleOf(call.prompt, call.description)}</span>
						<Chip icon={look.icon} iconColor={look.tone}>
							{look.label}
						</Chip>
						{status === 'failed' ? <Chip tone="danger">Failed</Chip> : status === 'stopped' ? <Chip>Stopped</Chip> : null}
						<span className="flex-1" />
						{run ? (
							<span className="in-num hidden shrink-0 text-micro text-(--text-3) sm:inline">
								{run.steps.length} {run.steps.length === 1 ? 'step' : 'steps'}
							</span>
						) : null}
						{run ? <span className={cn('in-num w-12 shrink-0 text-right text-micro', live ? 'text-(--accent-text)' : 'text-(--text-3)')}>{elapsed(runElapsed(run, now))}</span> : null}
					</span>
					{live ? (
						<span className="agent-live-line flex min-w-0 items-center gap-1.5 pl-[22px] text-small">
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

export function AgentsCard({ sessionId, calls }: { sessionId: string; calls: Delegation[] }) {
	const runs = useSubagentRuns(sessionId).data?.runs ?? [];
	const matched = calls.map((call) => ({ call, run: runFor(runs, call) }));
	const working = matched.some(({ call, run }) => (run ? run.status === 'running' : call.running));
	const now = useNow(working);
	return (
		<section
			aria-label={calls.length === 1 ? '1 agent on this reply' : `${calls.length} agents on this reply`}
			className="in-tile flex flex-col divide-y divide-(--line) overflow-hidden"
		>
			{matched.map(({ call, run }) => (
				<AgentRow key={call.toolCallId} sessionId={sessionId} call={call} run={run} now={now} />
			))}
		</section>
	);
}
