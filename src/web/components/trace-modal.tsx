import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { ChartGantt, ChevronDown, ChevronRight, CircleAlert, FoldVertical, ListTree, Pause, Play, RotateCcw, Search, Sparkles, X, Zap } from 'lucide-react';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Disclosure } from '@/components/disclosure';
import { Logo } from '@/components/illustrations';
import { Caption, Chip, Count, IconTile, SplitBar, Status, type Tone } from '@/components/instrument';
import { Btn, Icon, IconBtn, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, Spinner } from '@/components/signal';
import { AgentTile, lookOf, titleOf } from '@/components/subagents';
import { describeTool } from '@/components/tool-describe';
import { api } from '@/lib/api';
import { dollars, tokens } from '@/lib/format';
import { callNumber, parsedInput, previousCall, seconds, shortModel, timeTicks, type TraceNode, type TraceRow, traceRows, traceStats, traceTree } from '@/lib/trace-view';
import { useElementSize } from '@/lib/use-element-size';
import { cn } from '@/lib/utils';
import { type AgentSpan, cacheShare, cacheVerdict, type CompactionSpan, type ModelSpan, PART_LABELS, type ToolSpan, type Trace, TRACE_PARTS, type TraceMessage, type TracePart } from '../../core/trace';

/*
 * A reply's trace, opened from its footer: the reply's totals, then every
 * model call and tool call it made on one clock, each subagent's calls under
 * the call that started it, and the step picked in a card beside them: what
 * went into a model call's context, whether the provider's cache held and
 * why, and each tool call's input and output. It can be replayed.
 */

const PART_COLORS: Record<TracePart, string> = {
	messages: 'var(--data-1)',
	systemPrompt: 'var(--data-2)',
	tools: 'var(--data-3)',
	mcpTools: 'var(--data-4)',
	skills: 'var(--data-5)',
};

const TONE_FILL: Record<Tone, string> = {
	neutral: 'var(--neutral-400)',
	accent: 'var(--accent-base)',
	success: 'var(--success-base)',
	warning: 'var(--warning-base)',
	danger: 'var(--danger-base)',
};

const TONE_TEXT: Record<Tone, string> = {
	neutral: '',
	accent: 'text-(--accent-text)',
	success: 'text-(--success-text)',
	warning: 'text-(--warning-text)',
	danger: 'text-(--danger-text)',
};

const SPEEDS = [1, 2, 5, 10, 25, 50];

/** Waiting on others, as the hatching under a group's own calls. */
const hatch = (hue: string): CSSProperties => ({
	backgroundImage: `repeating-linear-gradient(135deg, color-mix(in oklab, ${hue} 34%, transparent) 0 1.5px, transparent 1.5px 6px)`,
	boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${hue} 30%, transparent)`,
});
const toolFill = (hue: string) => `color-mix(in oklab, ${hue} 46%, var(--neutral-750))`;

/** The trace modal, over the whole app; Escape or the scrim closes it. */
export function TraceModal({ sessionId, traceId, onClose }: { sessionId: string; traceId: string; onClose: () => void }) {
	const trace = useQuery({ queryKey: ['trace', sessionId, traceId], queryFn: () => api.trace(sessionId, traceId), staleTime: Infinity, retry: 1 });
	return createPortal(
		<div
			className="fixed inset-0 z-[150] flex items-center justify-center bg-(--bg-scrim) p-2 backdrop-blur-[2px] sm:p-6"
			onMouseDown={(event) => event.target === event.currentTarget && onClose()}
		>
			<div role="dialog" aria-modal="true" aria-label="Reply trace" className="in-pop in-pop--modal flex h-[min(820px,100%)] w-[min(1240px,100%)] flex-col overflow-hidden">
				{trace.data ? (
					<TraceView trace={trace.data} onClose={onClose} />
				) : (
					<>
						<TraceHeader sub={null} onClose={onClose} />
						<div className="flex flex-1 items-center justify-center gap-2 text-[12.5px] text-(--text-tertiary)">
							{trace.isError ? (
								<>
									<Icon icon={CircleAlert} size={13} />
									This reply's trace isn't kept any more.
								</>
							) : (
								<>
									<Spinner size={13} /> Loading the trace
								</>
							)}
						</div>
					</>
				)}
			</div>
		</div>,
		document.body,
	);
}

function TraceHeader({ sub, children, onClose }: { sub: ReactNode; children?: ReactNode; onClose: () => void }) {
	return (
		<header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-(--border-subtle) px-4">
			<IconTile icon={ChartGantt} tone="accent" />
			<div className="flex min-w-0 flex-1 items-baseline gap-1.5">
				<h2 className="m-0 shrink-0 text-[13.5px] font-medium text-(--text-primary)">Trace</h2>
				{sub ? (
					<>
						<span className="text-[12px] text-(--text-disabled)">/</span>
						<span className="min-w-0 truncate text-[12px] text-(--text-tertiary)">{sub}</span>
					</>
				) : null}
			</div>
			{children}
			<IconBtn icon={X} size="sm" label="Close trace" onClick={onClose} />
		</header>
	);
}

function TraceView({ trace, onClose }: { trace: Trace; onClose: () => void }) {
	const tree = useMemo(() => traceTree(trace), [trace]);
	const stats = useMemo(() => traceStats(trace), [trace]);
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
	const [query, setQuery] = useState('');
	const rows = useMemo(() => traceRows(tree, folded, query), [tree, folded, query]);
	const [selected, setSelected] = useState<string | null>(null);
	const picked = useMemo(() => (selected ? findNode(tree, selected) : null), [tree, selected]);
	const search = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const replay = useReplay(trace.durationMs);
	const total = Math.max(trace.durationMs, 1);

	const toggle = useCallback((key: string) => setFolded((current) => {
		const next = new Set(current);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		return next;
	}), []);

	const select = useCallback((key: string | null) => {
		setSelected(key);
		if (key) requestAnimationFrame(() => list.current?.querySelector(`[data-row="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' }));
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const typing = event.target instanceof HTMLInputElement;
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				if (typing && query) setQuery('');
				else if (selected) setSelected(null);
				else onClose();
				return;
			}
			if ((event.key === 'f' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
				event.preventDefault();
				search.current?.focus();
				return;
			}
			if (typing && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
			const index = rows.findIndex((row) => row.key === selected);
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
				if (next) select(next.key);
			} else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && index >= 0 && rows[index].children.length) {
				event.preventDefault();
				if ((event.key === 'ArrowLeft') !== rows[index].folded) toggle(rows[index].key);
			} else if (event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
				event.preventDefault();
				replay.toggle();
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [rows, selected, query, onClose, select, toggle, replay]);

	// As many time marks as fit their labels, about one per 72px of track.
	const [axis, axisSize] = useElementSize<HTMLDivElement>();
	const ticks = useMemo(() => timeTicks(total, Math.max(2, Math.floor(axisSize.width / 64))), [total, axisSize.width]);
	const when = new Date(trace.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

	return (
		<>
			<TraceHeader sub={`Anton · ${shortModel(trace.model) || 'model'} · ${when}`} onClose={onClose}>
				<label className="hidden h-8 w-[260px] items-center gap-2 rounded-[9px] border border-(--border-default) bg-(--bg-inset) px-2.5 focus-within:border-(--accent-border) sm:flex">
					<Icon icon={Search} size={13} className="text-(--icon-tertiary)" />
					<input
						ref={search}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search steps, inputs, outputs"
						aria-label="Search the trace"
						className="min-w-0 flex-1 bg-transparent text-[12.5px] text-(--text-primary) outline-none placeholder:text-(--text-placeholder)"
					/>
					{query ? <IconBtn icon={X} size="xs" label="Clear search" onClick={() => setQuery('')} /> : <Kbd keys="mod+f" size="sm" />}
				</label>
			</TraceHeader>
			<TraceStatsRow stats={stats} trace={trace} />
			<div className="relative flex min-h-0 flex-1 flex-col" style={{ '--tree': 'clamp(170px, 32%, 340px)' } as CSSProperties}>
				<div className="grid h-8 shrink-0 grid-cols-[var(--tree)_minmax(0,1fr)] border-b border-(--border-subtle)">
					<div className="flex items-center gap-1.5 px-4 text-(--text-tertiary)">
						<Icon icon={ListTree} size={12} />
						<Caption>Steps</Caption>
						<Count>{trace.spans.length}</Count>
					</div>
					<TimeAxis ref={axis} ticks={ticks} total={total} head={replay.head} onScrub={replay.scrub} />
				</div>
				<div ref={list} role="tree" aria-label="Steps" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
					<div className="relative min-h-full">
						<GridLines ticks={ticks} total={total} head={replay.head} />
						{rows.map((row) => (
							<StepRow
								key={row.key}
								row={row}
								trace={trace}
								total={total}
								head={replay.head}
								slowest={stats.slowest}
								selected={row.key === selected}
								onSelect={() => select(row.key === selected ? null : row.key)}
								onToggle={() => toggle(row.key)}
							/>
						))}
						{rows.length === 0 ? <div className="px-4 py-6 text-[12.5px] text-(--text-tertiary)">No step matches “{query}”.</div> : null}
						{trace.dropped ? <div className="px-4 py-3 text-[11.5px] text-(--text-disabled)">{trace.dropped} later steps weren't kept: a trace keeps its first 600.</div> : null}
					</div>
				</div>
				{picked ? <StepCard node={picked} trace={trace} onClose={() => setSelected(null)} onSelect={select} /> : null}
			</div>
			<TraceFooter replay={replay} total={total} />
		</>
	);
}

function findNode(node: TraceNode, key: string): TraceNode | null {
	if (node.key === key) return node;
	for (const child of node.children) {
		const found = findNode(child, key);
		if (found) return found;
	}
	return null;
}

function TraceStatsRow({ stats, trace }: { stats: ReturnType<typeof traceStats>; trace: Trace }) {
	const hitTone: Tone = !stats.input ? 'neutral' : stats.hit >= 0.6 ? 'success' : stats.hit >= 0.25 ? 'warning' : 'danger';
	const items: Array<{ label: string; value: string; note?: string; tone?: Tone; title?: string }> = [
		{ label: 'Duration', value: seconds(stats.durationMs) },
		{ label: 'Cost', value: dollars(stats.cost), note: stats.cost === 0 ? 'on a plan, or free' : undefined },
		{ label: 'Tokens', value: tokens(stats.input + stats.output), note: `${tokens(stats.input)} in · ${tokens(stats.output)} out` },
		{
			label: 'Cache',
			value: stats.input ? `${Math.round(stats.hit * 100)}%` : '—',
			note: stats.input ? `${tokens(stats.cacheRead)} read · ${tokens(stats.cacheWrite)} written` : undefined,
			tone: hitTone,
			title: 'The share of all input read from the provider’s cache',
		},
		{ label: 'Model calls', value: String(stats.modelCalls), note: stats.agents ? `${stats.agents} subagent${stats.agents === 1 ? '' : 's'}` : undefined },
		{ label: 'Tool calls', value: String(stats.toolCalls) },
		{ label: 'Errors', value: String(stats.errors), tone: stats.errors ? 'danger' : undefined },
	];
	return (
		<div className="grid shrink-0 grid-cols-4 border-b border-(--border-subtle) sm:grid-cols-7" aria-label={`Trace of a reply on ${trace.model ?? 'a model'}`}>
			{items.map((item, index) => (
				<div key={item.label} title={item.title} className={cn('flex min-w-0 flex-col gap-1 px-3 py-2.5 sm:px-4', index > 0 && 'sm:border-l sm:border-(--border-subtle)', index >= 4 && 'max-sm:hidden')}>
					<span className="truncate text-[11px] text-(--text-tertiary)">{item.label}</span>
					<span className={cn('in-figure truncate text-[16px] leading-[22px] sm:text-[19px] sm:leading-[24px]', item.tone && TONE_TEXT[item.tone])}>{item.value}</span>
					{item.note ? <span className="in-num truncate text-[10.5px] text-(--text-disabled)">{item.note}</span> : <span className="h-[15px]" />}
				</div>
			))}
		</div>
	);
}

/** Where a time falls along the track, as a CSS length inside it. */
const pos = (ms: number, total: number) => `${Math.max(0, Math.min(100, (ms / total) * 100))}%`;

/** The track's insets inside the timeline column: room before the first bar, and after the last for its label. */
const TRACK = 'absolute inset-y-0 left-3 right-[72px] sm:right-[118px]';

function TimeAxis({ ref, ticks, total, head, onScrub }: { ref: (element: HTMLDivElement | null) => void; ticks: number[]; total: number; head: number | null; onScrub: (ms: number) => void }) {
	const track = useRef<HTMLDivElement>(null);
	const scrubAt = (clientX: number) => {
		const box = track.current?.getBoundingClientRect();
		if (box) onScrub(Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * total);
	};
	return (
		<div className="relative cursor-col-resize border-l border-(--border-subtle)" onPointerDown={(event) => {
			event.currentTarget.setPointerCapture(event.pointerId);
			scrubAt(event.clientX);
		}} onPointerMove={(event) => event.buttons === 1 && scrubAt(event.clientX)} title="Drag to scrub through the reply">
			<div
				ref={(element) => {
					track.current = element;
					ref(element);
				}}
				className={TRACK}
			>
				{ticks.map((tick) => (
					<span key={tick} className="in-num absolute top-1/2 -translate-y-1/2 pl-1.5 text-[10.5px] text-(--text-disabled)" style={{ left: pos(tick, total) }}>
						{seconds(tick)}
					</span>
				))}
				{head !== null ? (
					<span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--text-primary) shadow-[0_0_0_3px_var(--bg-overlay)]" style={{ left: pos(head, total) }} />
				) : null}
			</div>
		</div>
	);
}

function GridLines({ ticks, total, head }: { ticks: number[]; total: number; head: number | null }) {
	return (
		<div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 left-(--tree) border-l border-(--border-subtle)">
			<div className={TRACK}>
				{ticks.map((tick) => (
					<span key={tick} className="absolute inset-y-0 w-px bg-(--grid-line)" style={{ left: pos(tick, total) }} />
				))}
				{head !== null ? <span className="absolute inset-y-0 z-[1] w-px bg-(--text-secondary) opacity-70" style={{ left: pos(head, total) }} /> : null}
			</div>
		</div>
	);
}

/** A row's icon: the agent's mark, a subagent's tile, or what kind of call it was. */
function RowIcon({ node }: { node: TraceNode }) {
	const span = node.span;
	if (!span) return <Logo size={16} />;
	if (span.kind === 'agent') return <AgentTile agent={span.agent} size={18} />;
	const icon: LucideIcon = span.kind === 'model' ? Sparkles : span.kind === 'compaction' ? FoldVertical : describeTool({ toolName: span.tool, input: parsedInput(span) }).icon;
	return (
		<span
			className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px]"
			style={span.error ? { color: 'var(--danger-text)', background: 'var(--danger-bg)' } : { color: span.kind === 'model' ? node.hue : 'var(--icon-secondary)', background: 'var(--alpha-white-6)' }}
		>
			<Icon icon={icon} size={11} />
		</span>
	);
}

/** What a row says: a short name and, dimmer, what it worked on. */
function rowText(node: TraceNode, trace: Trace): { label: ReactNode; sub: string } {
	const span = node.span;
	if (!span) return { label: 'Anton', sub: shortModel(trace.model) };
	switch (span.kind) {
		case 'model': {
			// The model is named only where it differs from the agent's; what the call led to says more.
			const calls = span.output.toolCalls.map((call) => call.name);
			const did = calls.length ? `→ ${calls.length > 2 ? `${calls.slice(0, 2).join(', ')} +${calls.length - 2}` : calls.join(', ')}` : span.output.text ? 'answered' : null;
			return {
				label: span.purpose === 'agent' ? 'Model call' : 'Summarized the conversation',
				sub: [span.model !== trace.model ? shortModel(span.model) : null, did, span.usage ? `${tokens(cacheShare(span.usage).total)} in` : null].filter(Boolean).join(' · '),
			};
		}
		case 'tool':
			return { label: describeTool({ toolName: span.tool, input: parsedInput(span) }).body, sub: '' };
		case 'agent':
			return { label: lookOf(span.agent).label, sub: titleOf(span.prompt, span.description ?? undefined) };
		case 'compaction':
			return { label: 'Compacted the conversation', sub: span.tokensBefore ? `${tokens(span.tokensBefore)} tokens` : '' };
	}
}

function StepRow({
	row,
	trace,
	total,
	head,
	slowest,
	selected,
	onSelect,
	onToggle,
}: {
	row: TraceRow;
	trace: Trace;
	total: number;
	head: number | null;
	slowest: string | null;
	selected: boolean;
	onSelect: () => void;
	onToggle: () => void;
}) {
	const { label, sub } = rowText(row, trace);
	const group = row.children.length > 0 || row.group !== null;
	return (
		<div
			data-row={row.key}
			role="treeitem"
			aria-selected={selected}
			aria-level={row.depth + 1}
			aria-expanded={row.children.length ? !row.folded : undefined}
			onClick={onSelect}
			className={cn(
				'relative grid h-[30px] cursor-default grid-cols-[var(--tree)_minmax(0,1fr)] items-center transition-colors duration-(--duration-micro)',
				selected ? 'bg-(--bg-selected)' : 'hover:bg-(--bg-hover)',
				row.match && 'shadow-[inset_2px_0_0_var(--warning-base)]',
			)}
		>
			<div className="relative flex h-full min-w-0 items-center gap-1.5 pr-2" style={{ paddingLeft: 10 + row.depth * 16 }}>
				{Array.from({ length: row.depth }, (_, level) => (
					<span key={level} aria-hidden className="absolute inset-y-0 w-px bg-(--border-subtle)" style={{ left: 18 + level * 16 }} />
				))}
				{row.children.length ? (
					<button
						type="button"
						aria-label={row.folded ? 'Show its steps' : 'Hide its steps'}
						onClick={(event) => {
							event.stopPropagation();
							onToggle();
						}}
						className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-(--icon-tertiary) outline-none hover:bg-(--bg-active) hover:text-(--icon-primary) focus-visible:shadow-(--focus-ring)"
					>
						<Icon icon={row.folded ? ChevronRight : ChevronDown} size={12} />
					</button>
				) : (
					<span className="w-4 shrink-0" />
				)}
				<RowIcon node={row} />
				<span className={cn('min-w-0 shrink truncate text-[12.5px]', row.span?.error ? 'text-(--danger-text)' : 'text-(--text-primary)', group && 'font-medium')}>{label}</span>
				{sub ? <span className="min-w-0 flex-1 truncate text-[12px] text-(--text-tertiary)">{sub}</span> : null}
			</div>
			<div className="relative h-full">
				<div className={TRACK}>
					<Bar row={row} trace={trace} total={total} head={head} slowest={slowest === row.span?.id} />
				</div>
			</div>
		</div>
	);
}

/** How much of a span the replay has reached: 0 before it starts, 1 once it ends. */
const reached = (start: number, duration: number, head: number | null) => (head === null ? 1 : duration <= 0 ? (head >= start ? 1 : 0) : Math.max(0, Math.min(1, (head - start) / duration)));

function Bar({ row, trace, total, head, slowest }: { row: TraceRow; trace: Trace; total: number; head: number | null; slowest: boolean }) {
	const span = row.span;
	const duration = Math.max(0, row.end - row.start);
	const shown = reached(row.start, duration, head);
	const end = row.start + duration;
	// The label goes after the bar, into the room kept right of the track, unless a long one would run off it.
	const nearEnd = end / total > 0.9 && row.start / total > 0.35;
	const width = (ms: number) => `max(3px, ${(ms / total) * 100}%)`;
	const failed = Boolean(span?.error);
	const fill = failed ? 'var(--danger-base)' : span?.kind === 'model' ? row.hue : span?.kind === 'compaction' ? 'var(--warning-base)' : toolFill(row.hue);
	// A group's bar is hatched while it waits on its own calls and subagents, solid where it called its model.
	const own = row.group ? trace.spans.filter((other): other is ModelSpan => other.kind === 'model' && other.lane === row.group) : [];
	const verdict = span?.kind === 'model' ? cacheVerdict(span, previousCall(trace, span)) : null;
	const cost = span?.kind === 'model' ? (span.usage?.cost ?? 0) : row.group ? traceStats(trace, row.group === 'main' ? undefined : row.group).cost : 0;
	return (
		<>
			{shown > 0 ? (
				row.group ? (
					<div className="absolute top-1/2 h-3.5 -translate-y-1/2 overflow-hidden rounded-[4px]" style={{ left: pos(row.start, total), width: width(duration * shown), ...hatch(row.hue) }}>
						{own.map((call) => {
							const part = reached(call.start, call.durationMs, head);
							if (part <= 0) return null;
							return (
								<span
									key={call.id}
									className="absolute inset-y-0 rounded-[3px]"
									style={{
										left: `${((call.start - row.start) / Math.max(duration * shown, 1)) * 100}%`,
										width: `max(3px, ${((call.durationMs * part) / Math.max(duration * shown, 1)) * 100}%)`,
										background: call.error ? 'var(--danger-base)' : row.hue,
									}}
								/>
							);
						})}
					</div>
				) : (
					<div
						className={cn('absolute top-1/2 flex h-3.5 -translate-y-1/2 items-center justify-center rounded-[4px]', span?.kind === 'compaction' && 'opacity-80')}
						style={{ left: pos(row.start, total), width: width(duration * shown), background: fill }}
					>
						{failed && duration / total > 0.02 ? <Icon icon={X} size={10} className="text-(--danger-fg)" /> : null}
					</div>
				)
			) : (
				<div className="absolute top-1/2 h-3.5 -translate-y-1/2 rounded-[4px] border border-dashed border-(--border-default)" style={{ left: pos(row.start, total), width: width(duration) }} />
			)}
			{shown >= 1 ? (
				<span
					className="in-num absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-[10.5px] whitespace-nowrap text-(--text-tertiary)"
					style={nearEnd ? { right: `calc(${100 - (row.start / total) * 100}% + 6px)` } : { left: `calc(${pos(end, total)} + 6px)` }}
				>
					<span>
						{seconds(duration)}
						{cost > 0 ? ` · ${dollars(cost)}` : ''}
					</span>
					{verdict && verdict.tone !== 'neutral' ? (
						<span className="inline-flex items-center gap-1" style={{ color: TONE_FILL[verdict.tone] }} title={verdict.why}>
							<Icon icon={Zap} size={10} />
							{verdict.label.replace(/^Partial · /, '').replace(/^Hit · /, '')}
						</span>
					) : null}
					{slowest ? <Status tone="warning">Slowest</Status> : null}
				</span>
			) : null}
		</>
	);
}

type Replay = { head: number | null; playing: boolean; speed: number; setSpeed: (speed: number) => void; toggle: () => void; restart: () => void; scrub: (ms: number) => void; clear: () => void };

/** Replaying the reply: a playhead that runs along the timeline at a chosen speed, revealing each step as it happened. */
function useReplay(total: number): Replay {
	const [head, setHead] = useState<number | null>(null);
	const [playing, setPlaying] = useState(false);
	// The slowest speed that replays the reply in under 15 seconds.
	const [speed, setSpeed] = useState(() => SPEEDS.find((value) => total / value <= 15_000) ?? SPEEDS.at(-1)!);
	const frame = useRef(0);
	useEffect(() => {
		if (!playing) return;
		let last = performance.now();
		const step = (now: number) => {
			const delta = (now - last) * speed;
			last = now;
			let done = false;
			setHead((current) => {
				const next = Math.min(total, (current ?? 0) + delta);
				done = next >= total;
				return next;
			});
			if (done) setPlaying(false);
			else frame.current = requestAnimationFrame(step);
		};
		frame.current = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame.current);
	}, [playing, speed, total]);
	return useMemo(
		() => ({
			head,
			playing,
			speed,
			setSpeed,
			toggle: () => {
				if (playing) return setPlaying(false);
				if (head === null || head >= total) setHead(0);
				setPlaying(true);
			},
			restart: () => {
				setHead(0);
				setPlaying(true);
			},
			scrub: (ms: number) => {
				setPlaying(false);
				setHead(ms);
			},
			clear: () => {
				setPlaying(false);
				setHead(null);
			},
		}),
		[head, playing, speed, total],
	);
}

function TraceFooter({ replay, total }: { replay: Replay; total: number }) {
	return (
		<footer className="flex h-12 shrink-0 items-center gap-1.5 border-t border-(--border-subtle) px-3">
			<IconBtn icon={replay.playing ? Pause : Play} size="sm" variant="secondary" className="sg-btn--round" label={replay.playing ? 'Pause' : 'Replay the reply'} onClick={replay.toggle} />
			<IconBtn icon={RotateCcw} size="sm" label="Replay from the start" onClick={replay.restart} />
			<Menu>
				<MenuTrigger asChild>
					<Btn size="sm" variant="ghost" className="in-num gap-1 px-2 text-[11.5px]" aria-label="Replay speed">
						{replay.speed}×
						<Icon icon={ChevronDown} size={11} className="text-(--icon-tertiary)" />
					</Btn>
				</MenuTrigger>
				<MenuContent align="start" side="top" className="min-w-[120px]">
					{SPEEDS.map((speed) => (
						<MenuItem key={speed} checked={speed === replay.speed} onSelect={() => replay.setSpeed(speed)}>
							{speed}×
						</MenuItem>
					))}
				</MenuContent>
			</Menu>
			{replay.head !== null ? (
				<>
					<span className="in-num text-[11px] text-(--text-tertiary)">
						{seconds(replay.head)} <span className="text-(--text-disabled)">/ {seconds(total)}</span>
					</span>
					<Btn size="sm" variant="ghost" className="px-2 text-[11.5px] text-(--text-tertiary)" onClick={replay.clear}>
						Show all
					</Btn>
				</>
			) : null}
			<span className="flex-1" />
			<div className="hidden items-center gap-3.5 text-[11px] text-(--text-tertiary) md:flex">
				<Legend swatch={{ background: 'var(--data-1)' }}>Model call</Legend>
				<Legend swatch={{ background: toolFill('var(--data-1)') }}>Tool call</Legend>
				<Legend swatch={hatch('var(--neutral-300)')}>Waiting</Legend>
				<Legend swatch={{ background: 'var(--danger-base)' }}>Failed</Legend>
				<span className="h-3 w-px bg-(--border-default)" />
				<span className="inline-flex items-center gap-1.5">
					<Icon icon={Zap} size={11} />
					Cache
				</span>
				{(['success', 'warning', 'danger'] as const).map((tone) => (
					<span key={tone} className="inline-flex items-center gap-1">
						<span className="size-1.5 rounded-full" style={{ background: TONE_FILL[tone] }} />
						{tone === 'success' ? 'Hit' : tone === 'warning' ? 'Partial' : 'Miss'}
					</span>
				))}
			</div>
		</footer>
	);
}

function Legend({ swatch, children }: { swatch: CSSProperties; children: ReactNode }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className="h-2 w-3.5 rounded-[2px]" style={swatch} />
			{children}
		</span>
	);
}

/* ------------------------------------------------------------------ */
/* The picked step, in a card beside the timeline.                      */
/* ------------------------------------------------------------------ */

function StepCard({ node, trace, onClose, onSelect }: { node: TraceNode; trace: Trace; onClose: () => void; onSelect: (key: string) => void }) {
	const span = node.span;
	const { label } = rowText(node, trace);
	const failed = span?.error;
	return (
		<aside
			aria-label="Step details"
			className="in-pop absolute inset-x-2 bottom-2 z-10 flex max-h-[72%] flex-col overflow-hidden sm:inset-x-auto sm:top-3 sm:right-3 sm:bottom-3 sm:max-h-none sm:w-[420px]"
		>
			<header className="flex min-h-12 shrink-0 items-center gap-2.5 border-b border-(--border-subtle) px-3.5 py-2">
				<RowIcon node={node} />
				<div className="min-w-0 flex-1 truncate text-[13px] font-medium text-(--text-primary)">{label}</div>
				{span ? <Chip tone={failed ? 'danger' : 'success'}>{failed ? 'Failed' : 'Done'}</Chip> : null}
				<IconBtn icon={X} size="sm" label="Close details" onClick={onClose} />
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3.5 py-3.5 *:shrink-0">
				{failed ? (
					<div className="flex items-start gap-2 rounded-[10px] border border-(--danger-border) bg-(--danger-bg) px-3 py-2 text-[12px] leading-[18px] text-(--danger-text)">
						<Icon icon={CircleAlert} size={12} className="mt-[3px]" />
						<span className="min-w-0 break-words">{failed}</span>
					</div>
				) : null}
				{!span ? <ReplyDetail trace={trace} onSelect={onSelect} /> : null}
				{span?.kind === 'model' ? <ModelDetail span={span} trace={trace} onSelect={onSelect} /> : null}
				{span?.kind === 'tool' ? <ToolDetail span={span} trace={trace} onSelect={onSelect} /> : null}
				{span?.kind === 'agent' ? <AgentDetail span={span} trace={trace} /> : null}
				{span?.kind === 'compaction' ? <CompactionDetail span={span} /> : null}
			</div>
		</aside>
	);
}

function Facts({ items }: { items: Array<{ label: string; value: ReactNode; tone?: Tone }> }) {
	return (
		<dl className="m-0 grid grid-cols-3 gap-px overflow-hidden rounded-[10px] border border-(--border-subtle) bg-(--border-subtle)">
			{items.map((item) => (
				<div key={item.label} className="flex min-w-0 flex-col gap-0.5 bg-(--bg-raised) px-3 py-2">
					<dt className="truncate text-[11px] text-(--text-tertiary)">{item.label}</dt>
					<dd className={cn('in-num m-0 truncate text-[13px] text-(--text-primary)', item.tone && TONE_TEXT[item.tone])}>{item.value}</dd>
				</div>
			))}
		</dl>
	);
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<Caption className="flex-1">{title}</Caption>
				{hint ? <span className="in-num text-[10.5px] text-(--text-disabled)">{hint}</span> : null}
			</div>
			{children}
		</section>
	);
}

/** Text as it was sent or returned, in a well, scrolling past a height. */
function Pre({ text, tall }: { text: string; tall?: boolean }) {
	if (!text.trim()) return <span className="text-[12px] text-(--text-disabled)">Empty</span>;
	return (
		<pre className={cn('in-well m-0 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[17px] break-words whitespace-pre-wrap text-(--text-secondary)', tall ? 'max-h-[360px]' : 'max-h-[200px]')}>
			{text}
		</pre>
	);
}

/** A fold under a section: a line that opens onto what it names. */
function Fold({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex h-7 items-center gap-1.5 rounded-[6px] px-1 text-left text-[12px] text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
			>
				<Icon icon={open ? ChevronDown : ChevronRight} size={12} className="text-(--icon-tertiary)" />
				<span className="flex-1">{label}</span>
				{hint ? <span className="in-num text-[10.5px] text-(--text-disabled)">{hint}</span> : null}
			</button>
			<Disclosure open={open}>
				<div className="pt-1.5">{children}</div>
			</Disclosure>
		</div>
	);
}

const ROLE: Record<TraceMessage['role'], { label: string; tone: Tone }> = {
	user: { label: 'User', tone: 'accent' },
	assistant: { label: 'Model', tone: 'neutral' },
	toolResult: { label: 'Tool result', tone: 'warning' },
	system: { label: 'System', tone: 'neutral' },
};

function ModelDetail({ span, trace, onSelect }: { span: ModelSpan; trace: Trace; onSelect: (key: string) => void }) {
	const previous = previousCall(trace, span);
	const verdict = cacheVerdict(span, previous);
	const share = span.usage ? cacheShare(span.usage) : null;
	const tools = trace.toolsets[span.toolset] ?? [];
	const prompt = trace.prompts[span.prompt] ?? '';
	const totalParts = TRACE_PARTS.reduce((sum, part) => sum + span.parts[part], 0);
	return (
		<>
			<Facts
				items={[
					{ label: 'Duration', value: seconds(span.durationMs) },
					{ label: 'Started', value: `+${seconds(span.start)}` },
					{ label: 'Cost', value: span.usage ? dollars(span.usage.cost) : '—' },
					{ label: 'Input', value: share ? tokens(share.total) : '—' },
					{ label: 'Output', value: span.usage ? tokens(span.usage.output) : '—' },
					{ label: 'Messages', value: span.messages },
				]}
			/>
			<div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-(--text-tertiary)">
				<Chip mono>{shortModel(span.model)}</Chip>
				<Chip mono>call {callNumber(trace, span)}</Chip>
				{span.finish ? <Chip mono>{span.finish}</Chip> : null}
			</div>
			<Section title="Context" hint={totalParts ? `${tokens(totalParts)} tokens` : undefined}>
				<SplitBar
					label="What the request held, by part"
					format={(part) => tokens(part.value)}
					parts={TRACE_PARTS.filter((part) => span.parts[part] > 0).map((part) => ({ key: part, label: PART_LABELS[part], value: span.parts[part], color: PART_COLORS[part] }))}
				/>
				<div className="flex flex-col">
					<Fold label="System prompt" hint={prompt ? `${prompt.length.toLocaleString()} chars${previous && previous.prompt !== span.prompt ? ' · changed' : ''}` : undefined}>
						<Pre text={prompt} tall />
					</Fold>
					<Fold label="Tools offered" hint={`${tools.length}${previous && previous.toolset !== span.toolset ? ' · changed' : ''}`}>
						<div className="flex flex-wrap gap-1">
							{tools.map((tool) => (
								<Chip key={tool.name} mono title={`About ${tokens(tool.tokens)} tokens`}>
									{tool.name}
								</Chip>
							))}
						</div>
					</Fold>
				</div>
			</Section>
			<Section title="Cache">
				<div className="flex items-start gap-2">
					<Chip tone={verdict.tone === 'neutral' ? 'neutral' : verdict.tone} icon={Zap}>
						{verdict.label}
					</Chip>
					<p className="m-0 min-w-0 flex-1 text-[12px] leading-[17px] text-(--text-secondary)">{verdict.why}</p>
				</div>
				{share && share.total ? (
					<SplitBar
						label="Where the input came from"
						format={(part) => tokens(part.value)}
						parts={[
							{ key: 'read', label: 'Read from cache', value: share.read, color: 'var(--success-base)' },
							{ key: 'write', label: 'Written to cache', value: share.write, color: 'var(--warning-base)' },
							{ key: 'fresh', label: 'Uncached', value: share.fresh, color: 'var(--neutral-500)' },
						]}
					/>
				) : null}
			</Section>
			<Section title="Added to the context" hint={span.added.length ? `${span.added.length + span.addedMore} message${span.added.length + span.addedMore === 1 ? '' : 's'}` : undefined}>
				{span.addedMore ? <span className="text-[11.5px] text-(--text-disabled)">{span.addedMore} earlier not shown</span> : null}
				{span.added.length ? (
					span.added.map((message, index) => (
						<div key={index} className="flex flex-col gap-1">
							<div className="flex items-center gap-1.5">
								<Chip tone={ROLE[message.role].tone}>{ROLE[message.role].label}</Chip>
								{message.tool ? <span className="in-num text-[11px] text-(--text-tertiary)">{message.tool}</span> : null}
								<span className="in-num ml-auto text-[10.5px] text-(--text-disabled)">{message.chars.toLocaleString()} chars</span>
							</div>
							<Pre text={message.text} />
						</div>
					))
				) : (
					<span className="text-[12px] text-(--text-tertiary)">Nothing new: the same conversation as the call before.</span>
				)}
			</Section>
			<Section title="Output">
				{span.output.thinking ? (
					<Fold label="Thinking" hint={`${span.output.thinking.length.toLocaleString()} chars`}>
						<Pre text={span.output.thinking} tall />
					</Fold>
				) : null}
				{span.output.text ? <Pre text={span.output.text} /> : null}
				{span.output.toolCalls.length ? (
					<div className="flex flex-wrap gap-1">
						{span.output.toolCalls.map((call) => (
							<button key={call.id} type="button" onClick={() => onSelect(`tool:${call.id}`)} className="rounded-[6px] outline-none focus-visible:shadow-(--focus-ring)">
								<Chip mono icon={ChevronRight} className="hover:border-(--border-strong) hover:text-(--text-primary)">
									{call.name}
								</Chip>
							</button>
						))}
					</div>
				) : null}
				{!span.output.text && !span.output.thinking && !span.output.toolCalls.length ? <span className="text-[12px] text-(--text-disabled)">No output</span> : null}
			</Section>
		</>
	);
}

function ToolDetail({ span, trace, onSelect }: { span: ToolSpan; trace: Trace; onSelect: (key: string) => void }) {
	const caller = trace.spans.find((other): other is ModelSpan => other.kind === 'model' && other.output.toolCalls.some((call) => call.id === span.id));
	return (
		<>
			<Facts
				items={[
					{ label: 'Duration', value: seconds(span.durationMs) },
					{ label: 'Started', value: `+${seconds(span.start)}` },
					{ label: 'Output', value: `~${tokens(Math.ceil(span.outputChars / 4))} tok` },
				]}
			/>
			<div className="flex flex-wrap items-center gap-1.5">
				<Chip mono>{span.tool}</Chip>
				{caller ? (
					<button type="button" onClick={() => onSelect(`model:${caller.id}`)} className="rounded-[6px] outline-none focus-visible:shadow-(--focus-ring)">
						<Chip icon={Sparkles} className="hover:border-(--border-strong) hover:text-(--text-primary)">
							Called by model call {callNumber(trace, caller)}
						</Chip>
					</button>
				) : null}
			</div>
			<Section title="Input">
				<Pre text={span.input} tall />
			</Section>
			<Section title="Output" hint={span.outputChars > span.output.length ? `first ${span.output.length.toLocaleString()} of ${span.outputChars.toLocaleString()} chars` : `${span.outputChars.toLocaleString()} chars`}>
				<Pre text={span.output} tall />
			</Section>
		</>
	);
}

function AgentDetail({ span, trace }: { span: AgentSpan; trace: Trace }) {
	const stats = traceStats(trace, span.id);
	const model = trace.spans.find((other): other is ModelSpan => other.kind === 'model' && other.lane === span.id)?.model ?? null;
	return (
		<>
			<Facts
				items={[
					{ label: 'Duration', value: seconds(span.durationMs) },
					{ label: 'Started', value: `+${seconds(span.start)}` },
					{ label: 'Cost', value: dollars(stats.cost) },
					{ label: 'Model calls', value: stats.modelCalls },
					{ label: 'Tool calls', value: stats.toolCalls },
					{ label: 'Cache', value: stats.input ? `${Math.round(stats.hit * 100)}%` : '—' },
				]}
			/>
			{model ? (
				<div className="flex flex-wrap gap-1.5">
					<Chip mono>{shortModel(model)}</Chip>
					<Chip mono>{tokens(stats.input + stats.output)} tokens</Chip>
				</div>
			) : null}
			<Section title="Brief">
				<Pre text={span.prompt} tall />
			</Section>
			<Section title="Answer">
				<Pre text={span.result} tall />
			</Section>
		</>
	);
}

function CompactionDetail({ span }: { span: CompactionSpan }) {
	return (
		<>
			<Facts
				items={[
					{ label: 'Duration', value: seconds(span.durationMs) },
					{ label: 'Started', value: `+${seconds(span.start)}` },
					{ label: 'Before', value: span.tokensBefore ? `${tokens(span.tokensBefore)} tok` : '—' },
				]}
			/>
			<p className="m-0 text-[12px] leading-[18px] text-(--text-secondary)">
				The conversation{span.reason ? ` reached its ${span.reason === 'threshold' ? 'compaction point' : span.reason}` : ' was compacted'}: older turns were summarized
				{span.messagesBefore !== null && span.messagesAfter !== null ? `, from ${span.messagesBefore} messages to ${span.messagesAfter}` : ''}. The calls after it start a fresh cache.
			</p>
		</>
	);
}

function ReplyDetail({ trace, onSelect }: { trace: Trace; onSelect: (key: string) => void }) {
	const stats = traceStats(trace);
	const lanes = ['main', ...trace.spans.filter((span): span is AgentSpan => span.kind === 'agent').map((span) => span.id)];
	const calls = trace.spans.filter((span): span is ModelSpan => span.kind === 'model');
	return (
		<>
			<Facts
				items={[
					{ label: 'Duration', value: seconds(stats.durationMs) },
					{ label: 'Cost', value: dollars(stats.cost) },
					{ label: 'Cache', value: stats.input ? `${Math.round(stats.hit * 100)}%` : '—' },
				]}
			/>
			<Section title="Input per call" hint="cached · uncached">
				<div className="flex h-16 items-end gap-[3px]" role="img" aria-label="Each model call's input, cached and not">
					{calls.map((call) => {
						const share = call.usage ? cacheShare(call.usage) : null;
						const top = Math.max(1, ...calls.map((other) => (other.usage ? cacheShare(other.usage).total : 0)));
						return (
							<button
								key={call.id}
								type="button"
								title={`Call ${callNumber(trace, call)}: ${share ? `${tokens(share.total)} in, ${Math.round(share.hit * 100)}% cached` : 'no usage'}`}
								onClick={() => onSelect(`model:${call.id}`)}
								className="flex min-w-[4px] flex-1 flex-col justify-end overflow-hidden rounded-[2px] outline-none hover:opacity-80 focus-visible:shadow-(--focus-ring)"
								style={{ height: `${share ? Math.max(6, (share.total / top) * 100) : 6}%` }}
							>
								<span className="w-full bg-(--neutral-500)" style={{ flexGrow: share ? share.fresh + share.write : 1 }} />
								<span className="w-full bg-(--success-base)" style={{ flexGrow: share?.read ?? 0 }} />
							</button>
						);
					})}
				</div>
			</Section>
			<Section title="By conversation">
				<table className="w-full border-collapse text-[12px]">
					<thead>
						<tr className="in-caption text-left">
							<th className="pb-1 font-medium">Who</th>
							<th className="pb-1 text-right font-medium">Calls</th>
							<th className="pb-1 text-right font-medium">Tokens</th>
							<th className="pb-1 text-right font-medium">Cache</th>
						</tr>
					</thead>
					<tbody>
						{lanes.map((lane) => {
							const part = traceStats(trace, lane);
							const agent = trace.spans.find((span): span is AgentSpan => span.kind === 'agent' && span.id === lane);
							return (
								<tr key={lane} className="border-t border-(--border-subtle)">
									<td className="max-w-[150px] truncate py-1.5 text-(--text-secondary)">{agent ? `${lookOf(agent.agent).label} · ${titleOf(agent.prompt, agent.description ?? undefined)}` : 'Anton'}</td>
									<td className="in-num py-1.5 pl-3 text-right text-(--text-tertiary)">{part.modelCalls}</td>
									<td className="in-num py-1.5 pl-3 text-right text-(--text-primary)">{tokens(part.input + part.output)}</td>
									<td className="in-num py-1.5 pl-3 text-right text-(--text-primary)">{part.input ? `${Math.round(part.hit * 100)}%` : '—'}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</Section>
			<p className="m-0 text-[11.5px] leading-4 text-(--text-tertiary)">
				Every call sends the whole conversation again, so input adds up fast; a provider's cache reads the unchanged start of it at a lower price. Pick a model call to see what it held and why its cache hit or missed.
			</p>
		</>
	);
}

/** The footer's action: opens the reply's trace. */
export function TraceButton({ onOpen }: { onOpen: () => void }) {
	return <IconBtn size="xs" icon={ChartGantt} label="Trace this reply" onClick={onOpen} />;
}
