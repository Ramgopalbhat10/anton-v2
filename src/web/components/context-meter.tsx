import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useState } from 'react';
import { DATA_COLORS } from '@/components/charts';
import { useModels } from '@/components/model-picker';
import { Icon } from '@/components/signal';
import { api, type ContextPart, type ContextView, type PlanUsage } from '@/lib/api';
import { tokens as windowSize } from '@/lib/model-catalog';
import { age, dollars, tokens } from '@/lib/format';
import { cn } from '@/lib/utils';

/** What each part of the context is, in the order the bar and the list show them. */
const PARTS: Record<ContextPart, { label: string; color: string; help: string }> = {
	messages: { label: 'Messages', color: DATA_COLORS[0], help: 'The conversation: your messages, replies, and tool calls with their results' },
	tools: { label: 'Agent tools', color: DATA_COLORS[1], help: "Anton's tools the agent can call: files, shell, browser, pull requests" },
	systemPrompt: { label: 'System prompt', color: DATA_COLORS[2], help: "The agent's instructions, the repository's AGENTS.md and memory" },
	skills: { label: 'Skills', color: DATA_COLORS[3], help: 'The list of skills the agent can load' },
	mcpTools: { label: 'MCP tools', color: DATA_COLORS[4], help: "Tools from the repository's MCP servers and web search" },
};

const BUFFER = 'repeating-linear-gradient(135deg, var(--neutral-600) 0 2px, transparent 2px 4px)';

/** How full the window is, as a colour: calm, then amber from 70 percent, red from 90. */
const toneOf = (share: number) => (share >= 0.9 ? 'var(--danger-base)' : share >= 0.7 ? 'var(--warning-base)' : 'var(--accent-base)');

const percent = (value: number, of: number) => (of > 0 ? `${((value / of) * 100).toFixed(value / of < 0.1 ? 1 : 0)}%` : '—');

/** A ring that fills as the context does. */
function Ring({ share, size = 14 }: { share: number; size?: number }) {
	const r = (size - 3) / 2;
	const length = 2 * Math.PI * r;
	return (
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
			<circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--segment-off)" strokeWidth={2} />
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke={toneOf(share)}
				strokeWidth={2}
				strokeLinecap="round"
				strokeDasharray={`${Math.max(0.001, Math.min(1, share)) * length} ${length}`}
			/>
		</svg>
	);
}

function Row({ color, label, value, share, help, pattern }: { color: string; label: string; value: string; share: string; help?: string; pattern?: boolean }) {
	return (
		<div className="flex h-6 items-center gap-2 text-[12px]" title={help}>
			<span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: pattern ? BUFFER : color, boxShadow: pattern ? 'inset 0 0 0 1px var(--neutral-600)' : undefined }} />
			<span className="min-w-0 flex-1 truncate text-(--text-secondary)">{label}</span>
			<span className="in-num w-14 text-right text-[11px] text-(--text-tertiary)">{value}</span>
			<span className="in-num w-11 text-right text-[11px] text-(--text-primary)">{share}</span>
		</div>
	);
}

/** The window as one bar: each part in its colour, the room kept for compaction hatched at the end, the rest free. */
function Bar({ view }: { view: ContextView }) {
	const buffer = Math.max(0, view.window - view.autocompactAt);
	return (
		<div role="img" aria-label={`Context ${percent(view.used, view.window)} full`} className="flex h-2 gap-[2px] overflow-hidden rounded-full bg-(--segment-off)">
			{view.parts
				.filter((part) => part.tokens > 0)
				.map((part) => (
					<span key={part.key} className="h-full" style={{ width: `${(part.tokens / view.window) * 100}%`, minWidth: 2, background: PARTS[part.key].color }} />
				))}
			<span className="flex-1" />
			{buffer ? <span className="h-full" style={{ width: `${(buffer / view.window) * 100}%`, background: BUFFER }} /> : null}
		</div>
	);
}

/** For a model on a plan: its use as Anton saw it, and where its limits are. */
function PlanSection({ plan }: { plan: PlanUsage }) {
	const limitRecent = plan.limitHitAt !== null && Date.now() - new Date(plan.limitHitAt).getTime() < 24 * 3600_000;
	return (
		<section className="flex flex-col gap-2 border-t border-(--border-subtle) px-3.5 py-3">
			<div className="flex items-center gap-2">
				<span className="in-caption flex-1">{plan.name} plan</span>
				{plan.usagePage ? (
					<a href={plan.usagePage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-(--accent-text) hover:underline">
						Limits in {plan.name}
						<Icon icon={ArrowUpRight} size={11} />
					</a>
				) : null}
			</div>
			<div className="grid grid-cols-3 gap-2">
				{[
					['Today', tokens(plan.tokens.today)],
					['7 days', tokens(plan.tokens.week)],
					['At API prices', plan.apiValue === null ? '—' : `≈ ${dollars(plan.apiValue)}`],
				].map(([label, value]) => (
					<div
						key={label}
						className="flex flex-col gap-0.5"
						title={label === 'At API prices' ? 'What these calls would cost on a paid API, cached input at its lower price. On your plan you pay nothing per token.' : undefined}
					>
						<span className="in-num text-[13px] text-(--text-primary)">{value}</span>
						<span className="text-[10.5px] text-(--text-disabled)">{label}</span>
					</div>
				))}
			</div>
			<div className={cn('flex items-center gap-1.5 text-[11px]', limitRecent ? 'text-(--danger-text)' : 'text-(--text-tertiary)')}>
				<span className={cn('size-1.5 rounded-full', limitRecent ? 'bg-(--danger-base)' : 'bg-(--success-base)')} />
				{limitRecent ? `Usage limit reached ${age(plan.limitHitAt!)} ago` : 'No usage limit reached in the last day'}
			</div>
		</section>
	);
}

/** For a model billed per token: this task's spend, and today's against the daily cap. */
function SpendSection({ sessionId }: { sessionId: string }) {
	const budget = useQuery({ queryKey: ['budget', sessionId], queryFn: () => api.budget(sessionId) });
	if (!budget.data) return null;
	const { today, task, limits } = budget.data;
	const cap = limits.dailyUsd;
	const share = cap ? Math.min(1, today / cap) : 0;
	return (
		<section className="flex flex-col gap-2 border-t border-(--border-subtle) px-3.5 py-3">
			<div className="flex items-center gap-2 text-[12px]">
				<span className="in-caption flex-1">Spend</span>
				<span className="text-(--text-tertiary)">this task</span>
				<span className="in-num text-(--text-primary)">{dollars(task ?? 0)}</span>
			</div>
			<div className="flex items-center gap-2 text-[12px]">
				<span className="flex-1 text-(--text-secondary)">Today, all tasks</span>
				<span className="in-num text-(--text-primary)">
					{dollars(today)}
					{cap ? <span className="text-(--text-disabled)"> / ${cap}</span> : null}
				</span>
			</div>
			{cap ? (
				<div className="h-1.5 overflow-hidden rounded-full bg-(--segment-off)">
					<div className="h-full rounded-full" style={{ width: `${Math.max(1, share * 100)}%`, background: toneOf(share) }} />
				</div>
			) : null}
		</section>
	);
}

/**
 * How full this task's context window is, beside the composer. Open it for
 * the breakdown: what fills the window, how far it is from being compacted,
 * and what the task's model costs, on a plan or per token.
 */
export function ContextMeter({ sessionId, model }: { sessionId: string; model: string }) {
	const [open, setOpen] = useState(false);
	const context = useQuery({ queryKey: ['context', sessionId], queryFn: () => api.context(sessionId) });
	const models = useModels();
	const info = models.data?.models.find((entry) => entry.id === model);
	const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage, enabled: open && Boolean(info?.subscription) });
	const view = context.data;
	// Measured on another model, the share is of this one's window, which the next reply will use.
	const window = info?.contextLength || view?.window || 0;
	const measured = view && view.used > 0 ? { ...view, window, autocompactAt: view.window === window ? view.autocompactAt : Math.max(0, window - (view.window - view.autocompactAt)) } : null;
	const share = measured && window ? measured.used / window : 0;
	const plan = info?.subscription ? usage.data?.plans?.find((entry) => entry.name === info.subscription) : undefined;
	return (
		<PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
			<PopoverPrimitive.Trigger asChild>
				<button
					type="button"
					aria-label={measured ? `Context window ${percent(measured.used, window)} full` : 'Context window'}
					className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-[11px] text-(--text-tertiary) outline-none hover:bg-(--bg-hover) hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring) data-[state=open]:bg-(--bg-hover)"
				>
					<Ring share={share} />
					<span className="in-num">{measured ? percent(measured.used, window) : '—'}</span>
				</button>
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					side="top"
					align="end"
					sideOffset={8}
					collisionPadding={12}
					className="z-50 flex w-[min(320px,calc(100vw-24px))] in-pop flex-col overflow-hidden text-(--text-primary) outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
				>
					<section className="flex flex-col gap-2.5 px-3.5 pt-3 pb-3">
						<div className="flex items-baseline gap-2">
							<span className="text-[13px] font-medium">Context window</span>
							<span className="in-num ml-auto text-[11px] text-(--text-tertiary)">
								{measured ? (
									<>
										<span className="text-(--text-primary)">{tokens(measured.used)}</span> / <span title={`${window.toLocaleString()} tokens`}>{windowSize(window)}</span> (
										{percent(measured.used, window)})
									</>
								) : window ? (
									`${windowSize(window)} window`
								) : null}
							</span>
						</div>
						{measured ? (
							<>
								<Bar view={measured} />
								<div className="flex flex-col">
									{measured.parts.map((part) => (
										<Row key={part.key} color={PARTS[part.key].color} label={PARTS[part.key].label} help={PARTS[part.key].help} value={tokens(part.tokens)} share={percent(part.tokens, window)} />
									))}
									<Row
										color="var(--neutral-600)"
										pattern
										label="Autocompact buffer"
										help="Room kept for the next reply; reaching it makes the agent summarize older turns"
										value={tokens(window - measured.autocompactAt)}
										share={percent(window - measured.autocompactAt, window)}
									/>
									<Row
										color="var(--segment-off)"
										label="Free space"
										value={tokens(Math.max(0, measured.autocompactAt - measured.used))}
										share={percent(Math.max(0, measured.autocompactAt - measured.used), window)}
									/>
								</div>
								<div className="flex items-center gap-2 rounded-[8px] bg-(--well-bg) px-2.5 py-1.5 text-[11.5px]">
									<span className="in-num text-(--text-primary)">{tokens(Math.max(0, measured.autocompactAt - measured.used))}</span>
									<span className="text-(--text-tertiary)">until the agent compacts older turns</span>
								</div>
								{measured.task && measured.task.calls > 1 ? (
									<p className="m-0 text-[11px] leading-[16px] text-pretty text-(--text-disabled)">
										The window is what the agent holds now, not what you pay for. This task used{' '}
										<span className="in-num text-(--text-tertiary)">{tokens(measured.task.tokens)}</span> tokens over {measured.task.calls} model calls, its
										subagents' included: that is what usage and cost count. Each call reads its conversation again, so the total grows much faster than the window.
									</p>
								) : null}
							</>
						) : (
							<p className="m-0 text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">
								Measured from the agent's next reply: what its instructions, tools, skills and the conversation take of the model's window.
							</p>
						)}
					</section>
					{info?.subscription ? plan ? <PlanSection plan={plan} /> : null : <SpendSection sessionId={sessionId} />}
					<footer className="flex items-center gap-2 border-t border-(--border-subtle) px-3.5 py-2">
						<span className="in-caption flex-1 tracking-normal normal-case">{measured?.at ? `Measured ${age(measured.at)} ago` : 'Not measured yet'}</span>
						<a href="/settings/usage" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)">
							Usage details
							<Icon icon={ArrowUpRight} size={11} />
						</a>
					</footer>
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}
