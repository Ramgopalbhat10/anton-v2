import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { ArrowLeftRight, ChartGantt, ChevronDown, ChevronRight, CircleAlert, FoldVertical, ListTree, Minus, Pause, Play, Plus, RotateCcw, Search, Sparkles, X, Zap } from 'lucide-react';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Disclosure } from '@/components/disclosure';
import { HoverPeek } from '@/components/hover-peek';
import { useModels } from '@/components/model-picker';
import { Logo } from '@/components/illustrations';
import { Caption, Chip, Count, IconTile, Segmented, SegmentedItem, SplitBar, Status, type Tone } from '@/components/instrument';
import { Btn, Icon, IconBtn, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, Spinner } from '@/components/signal';
import { AgentTile, lookOf, titleOf } from '@/components/subagents';
import { describeTool } from '@/components/tool-describe';
import { api } from '@/lib/api';
import { dollars, tokens } from '@/lib/format';
import { vendorHue } from '@/lib/model-catalog';
import { logoFor, vendorSlug } from '@/lib/provider-logos';
import {
	autoZoom,
	callNumber,
	gatewayName,
	gatewayOf,
	type ModelChange,
	modelChanges,
	modelsUsed,
	parsedInput,
	previousCall,
	seconds,
	shortModel,
	timeTicks,
	type TraceNode,
	type TraceRow,
	traceRows,
	traceStats,
	traceTree,
} from '@/lib/trace-view';
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

/** Room before the first bar, and after the last for its label, inside the timeline. */
const LEAD = 12;
const tail = (narrow: boolean) => (narrow ? 72 : 118);

/** A layout choice kept in this browser: the steps column's width and how the timeline is stretched. */
function useStored<T>(key: string, fallback: T): [T, (value: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const saved = localStorage.getItem(key);
			return saved === null ? fallback : (JSON.parse(saved) as T);
		} catch {
			return fallback;
		}
	});
	const keep = useCallback(
		(next: T) => {
			setValue(next);
			try {
				localStorage.setItem(key, JSON.stringify(next));
			} catch {
				// Private windows and blocked storage keep the choice for this visit only.
			}
		},
		[key],
	);
	return [value, keep];
}

/** How the timeline is stretched: to fit its width, to read its typical call, or by a factor you chose. */
type Zoom = 'fit' | 'auto' | number;

/** The timeline's geometry: its column, how wide its track is drawn, and how to stretch it about a point on screen. */
function useTimeline(trace: Trace) {
	const scroller = useRef<HTMLDivElement | null>(null);
	const [measure, box] = useElementSize<HTMLDivElement>();
	const narrow = box.width > 0 && box.width < 640;
	const [treePref, setTreePref] = useStored<number | null>('anton.trace.tree', null);
	const [zoomPref, setZoomPref] = useStored<Zoom>('anton.trace.zoom', 'auto');
	const fallbackTree = narrow ? Math.min(170, box.width * 0.45) : Math.max(200, Math.min(340, box.width * 0.3));
	const tree = Math.round(Math.max(150, Math.min(treePref ?? fallbackTree, box.width * 0.6 || 340)));
	const fit = Math.max(160, box.width - tree - LEAD - tail(narrow));
	const auto = useMemo(() => autoZoom(trace, fit), [trace, fit]);
	const zoom = zoomPref === 'fit' ? 1 : zoomPref === 'auto' ? auto.zoom : Math.max(1, Math.min(auto.most, zoomPref));
	const width = Math.round(fit * zoom);
	const total = Math.max(trace.durationMs, 1);
	// Stretching keeps the moment under the pointer (or the middle of the view) where it was.
	const anchor = useRef<{ ms: number; x: number } | null>(null);
	const timeAt = (x: number) => ((scroller.current?.scrollLeft ?? 0) + x - tree - LEAD) / width * total;
	const stretch = useCallback(
		(next: Zoom, x = tree + (box.width - tree) / 2) => {
			anchor.current = { ms: Math.max(0, Math.min(total, timeAt(x))), x };
			setZoomPref(typeof next === 'number' ? Math.max(1, Math.min(auto.most, next)) : next);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[tree, box.width, width, total, auto.most, setZoomPref],
	);
	useLayoutEffect(() => {
		const held = anchor.current;
		anchor.current = null;
		if (held && scroller.current) scroller.current.scrollLeft = tree + LEAD + (held.ms / total) * width - held.x;
	}, [width, tree, total]);
	const bind = useCallback(
		(element: HTMLDivElement | null) => {
			scroller.current = element;
			measure(element);
		},
		[measure],
	);
	return { bind, scroller, narrow, tree, setTree: setTreePref, fit, width, outer: width + LEAD + tail(narrow), zoom, zoomPref, most: auto.most, stretch, total };
}

type Timeline = ReturnType<typeof useTimeline>;

function TraceView({ trace, onClose }: { trace: Trace; onClose: () => void }) {
	const tree = useMemo(() => traceTree(trace), [trace]);
	const stats = useMemo(() => traceStats(trace), [trace]);
	const changes = useMemo(() => modelChanges(trace), [trace]);
	const names = useModelNames();
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
	const [query, setQuery] = useState('');
	const rows = useMemo(() => traceRows(tree, folded, query), [tree, folded, query]);
	const [selected, setSelected] = useState<string | null>(null);
	const picked = useMemo(() => (selected ? findNode(tree, selected) : null), [tree, selected]);
	const search = useRef<HTMLInputElement>(null);
	const replay = useReplay(trace.durationMs);
	const line = useTimeline(trace);
	const total = line.total;

	const toggle = useCallback((key: string) => setFolded((current) => {
		const next = new Set(current);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		return next;
	}), []);

	const select = useCallback((key: string | null) => {
		setSelected(key);
		if (key) requestAnimationFrame(() => line.scroller.current?.querySelector(`[data-row="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' }));
	}, [line.scroller]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const typing = event.target instanceof HTMLInputElement && event.target.type !== 'range';
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
			if (!typing && (event.key === '=' || event.key === '+' || event.key === '-')) {
				event.preventDefault();
				line.stretch(line.zoom * (event.key === '-' ? 1 / 1.5 : 1.5));
				return;
			}
			if (!typing && event.key === '0') {
				line.stretch('fit');
				return;
			}
			if (typing && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
			if (event.target instanceof HTMLInputElement && event.target.type === 'range') return;
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
	}, [rows, selected, query, onClose, select, toggle, replay, line]);

	// Pinch or Ctrl/⌘ and the wheel stretch the timeline about the pointer; the wheel alone scrolls as usual.
	useEffect(() => {
		const element = line.scroller.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			const box = element.getBoundingClientRect();
			const x = event.clientX - box.left;
			if (x < line.tree) return;
			event.preventDefault();
			line.stretch(line.zoom * Math.exp(-event.deltaY * 0.0025), x);
		};
		element.addEventListener('wheel', onWheel, { passive: false });
		return () => element.removeEventListener('wheel', onWheel);
	}, [line]);

	// While it replays, the view follows the playhead.
	useEffect(() => {
		const element = line.scroller.current;
		if (!element || replay.head === null || !replay.playing) return;
		const x = line.tree + LEAD + (replay.head / total) * line.width;
		const view = element.clientWidth;
		if (x < element.scrollLeft + line.tree + 40 || x > element.scrollLeft + view - 60) element.scrollLeft = x - line.tree - (view - line.tree) * 0.3;
	}, [replay.head, replay.playing, line.tree, line.width, total, line.scroller]);

	// As many time marks as fit their labels, about one per 80px of track.
	const ticks = useMemo(() => timeTicks(total, Math.max(2, Math.floor(line.width / 80))), [total, line.width]);
	const when = new Date(trace.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

	return (
		<>
			<TraceHeader sub={<ReplyModels trace={trace} names={names} when={when} />} onClose={onClose}>
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
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div ref={line.bind} role="tree" aria-label="Steps" className="trace-scroll relative min-h-0 flex-1 overflow-auto overscroll-contain">
					<div className="relative min-h-full" style={{ width: line.tree + line.outer }}>
						<TimeAxis line={line} ticks={ticks} head={replay.head} changes={changes} names={names} count={trace.spans.length} onScrub={replay.scrub} />
						<div className="relative">
							<GridLines line={line} ticks={ticks} head={replay.head} changes={changes} />
							{rows.map((row) => (
								<StepRow
									key={row.key}
									row={row}
									trace={trace}
									line={line}
									names={names}
									head={replay.head}
									slowest={stats.slowest}
									switched={changes.find((change) => change.span === row.span?.id) ?? null}
									selected={row.key === selected}
									onSelect={() => select(row.key === selected ? null : row.key)}
									onToggle={() => toggle(row.key)}
								/>
							))}
						</div>
						{rows.length === 0 ? (
							<div className="sticky left-0 px-4 py-6 text-[12.5px] text-(--text-tertiary)" style={{ width: line.tree + line.fit }}>
								No step matches “{query}”.
							</div>
						) : null}
						{trace.dropped ? (
							<div className="sticky left-0 px-4 py-3 text-[11.5px] text-(--text-disabled)" style={{ width: line.tree + line.fit }}>
								{trace.dropped} later steps weren't kept: a trace keeps its first 600.
							</div>
						) : null}
					</div>
				</div>
				{picked ? <StepCard node={picked} trace={trace} names={names} onClose={() => setSelected(null)} onSelect={select} /> : null}
			</div>
			<TraceFooter replay={replay} line={line} />
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

/** The steps column's own background, so the timeline scrolls under it; a row's state is laid over it. */
const STICKY = 'sticky left-0 border-r border-(--border-subtle) bg-(--pop-bg)';

/** The handle on the steps column's edge: drag to widen it or narrow it, double-click to set it back. */
function ColumnGrip({ line }: { line: Timeline }) {
	return (
		<span
			role="separator"
			aria-orientation="vertical"
			aria-label="Drag to resize the steps column"
			title="Drag to resize the steps column; double-click to reset"
			className="group/grip absolute inset-y-0 -right-[3px] z-[1] w-[6px] cursor-col-resize"
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => {
				event.stopPropagation();
				line.setTree(null);
			}}
			onPointerDown={(event) => {
				event.stopPropagation();
				event.preventDefault();
				const from = event.clientX;
				const start = line.tree;
				const move = (next: PointerEvent) => line.setTree(Math.round(start + next.clientX - from));
				const up = () => {
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', up);
				};
				window.addEventListener('pointermove', move);
				window.addEventListener('pointerup', up);
			}}
		>
			<span className="absolute inset-y-0 left-[2.5px] w-px bg-transparent transition-colors duration-(--duration-micro) group-hover/grip:bg-(--accent-base)" />
		</span>
	);
}

function TimeAxis({
	line,
	ticks,
	head,
	changes,
	names,
	count,
	onScrub,
}: {
	line: Timeline;
	ticks: number[];
	head: number | null;
	changes: ModelChange[];
	names: ModelNames;
	count: number;
	onScrub: (ms: number) => void;
}) {
	const track = useRef<HTMLDivElement>(null);
	const total = line.total;
	const scrubAt = (clientX: number) => {
		const box = track.current?.getBoundingClientRect();
		if (box) onScrub(Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * total);
	};
	return (
		<div className="sticky top-0 z-[4] flex h-8 border-b border-(--border-subtle) bg-(--pop-bg)">
			<div className={cn(STICKY, 'z-[2] flex shrink-0 items-center gap-1.5 px-4 text-(--text-tertiary)')} style={{ width: line.tree }}>
				<Icon icon={ListTree} size={12} />
				<Caption>Steps</Caption>
				<Count>{count}</Count>
				<ColumnGrip line={line} />
			</div>
			<div
				className="relative shrink-0 cursor-col-resize"
				style={{ width: line.outer }}
				onPointerDown={(event) => {
					event.currentTarget.setPointerCapture(event.pointerId);
					scrubAt(event.clientX);
				}}
				onPointerMove={(event) => event.buttons === 1 && scrubAt(event.clientX)}
				title="Drag to scrub through the reply"
			>
				<div ref={track} className="absolute inset-y-0" style={{ left: LEAD, width: line.width }}>
					{ticks.map((tick) => (
						<span key={tick} className="in-num absolute top-1/2 -translate-y-1/2 pl-1.5 text-[10.5px] whitespace-nowrap text-(--text-disabled)" style={{ left: pos(tick, total) }}>
							{seconds(tick)}
						</span>
					))}
					{changes.map((change) => (
						<span
							key={change.span}
							className="absolute top-1/2 z-[1] flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-(--warning-border) bg-(--pop-bg) py-px pr-1.5 pl-[3px] text-[10px] whitespace-nowrap text-(--warning-text)"
							style={{ left: pos(change.at, total) }}
							title={`Model changed: ${names.of(change.from)} → ${names.of(change.to)}`}
						>
							<ModelLogo model={change.to.model} size={13} />
							{names.short(change.to)}
						</span>
					))}
					{head !== null ? (
						<span className="absolute top-1/2 z-[2] size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--text-primary) shadow-[0_0_0_3px_var(--bg-overlay)]" style={{ left: pos(head, total) }} />
					) : null}
				</div>
				<StretchGrip line={line} />
			</div>
		</div>
	);
}

/** The handle at the timeline's end: drag it right to stretch the timeline, left to squeeze it back. */
function StretchGrip({ line }: { line: Timeline }) {
	return (
		<span
			role="separator"
			aria-orientation="vertical"
			aria-label="Drag to stretch the timeline"
			title="Drag to stretch the timeline; double-click to fit it"
			className="group/stretch absolute inset-y-1 z-[3] flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center"
			style={{ left: LEAD + line.width }}
			onDoubleClick={(event) => {
				event.stopPropagation();
				line.stretch('fit');
			}}
			onPointerDown={(event) => {
				event.stopPropagation();
				event.preventDefault();
				const from = event.clientX;
				const start = line.width;
				const move = (next: PointerEvent) => line.stretch((start + next.clientX - from) / line.fit, line.tree);
				const up = () => {
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', up);
				};
				window.addEventListener('pointermove', move);
				window.addEventListener('pointerup', up);
			}}
		>
			<span className="h-4 w-[5px] rounded-full border border-(--border-strong) bg-(--bg-raised) transition-colors duration-(--duration-micro) group-hover/stretch:border-(--accent-border) group-hover/stretch:bg-(--accent-bg-subtle)" />
		</span>
	);
}

function GridLines({ line, ticks, head, changes }: { line: Timeline; ticks: number[]; head: number | null; changes: ModelChange[] }) {
	const total = line.total;
	return (
		<div aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: line.tree + LEAD, width: line.width }}>
			{ticks.map((tick) => (
				<span key={tick} className="absolute inset-y-0 w-px bg-(--grid-line)" style={{ left: pos(tick, total) }} />
			))}
			{changes.map((change) => (
				<span key={change.span} className="absolute inset-y-0 w-0 border-l border-dashed border-(--warning-border)" style={{ left: pos(change.at, total) }} />
			))}
			{head !== null ? <span className="absolute inset-y-0 z-[1] w-px bg-(--text-secondary) opacity-70" style={{ left: pos(head, total) }} /> : null}
		</div>
	);
}

/** Model names from the catalog, with the id's own last part when it isn't listed. */
type ModelNames = { of: (span: Pick<ModelSpan, 'model' | 'served'>) => string; short: (span: Pick<ModelSpan, 'model' | 'served'>) => string; name: (model: string) => string };

function useModelNames(): ModelNames {
	const models = useModels();
	return useMemo(() => {
		const byId = new Map<string, string>((models.data?.models ?? []).map((model) => [model.id, model.name]));
		const name = (model: string) => byId.get(model) ?? shortModel(model);
		// An alias names the model that answered (`~deepseek/deepseek-flash-latest` answered by `deepseek-v4-flash`).
		const served = (span: Pick<ModelSpan, 'model' | 'served'>) => (span.served && shortModel(span.served) !== shortModel(span.model) ? shortModel(span.served) : null);
		return {
			name,
			of: (span) => `${name(span.model)}${served(span) ? ` (${served(span)})` : ''}`,
			short: (span) => served(span) ?? shortModel(span.model),
		};
	}, [models.data]);
}

/** A model's vendor logo on a small tile, or its initials when the set has no logo. */
function ModelLogo({ model, size = 16, title }: { model: string; size?: number; title?: string }) {
	const logo = logoFor({ id: model });
	const vendor = vendorSlug({ id: model });
	const hue = vendorHue(vendor);
	return (
		<span
			aria-hidden={title ? undefined : true}
			title={title}
			className="inline-flex shrink-0 items-center justify-center rounded-[4px] font-mono font-semibold uppercase"
			style={
				logo
					? { width: size, height: size, fontSize: Math.round(size * 0.68), background: 'var(--alpha-white-6)', boxShadow: 'inset 0 0 0 1px var(--border-subtle)' }
					: { width: size, height: size, fontSize: size * 0.45, color: hue, background: `${hue}1f`, boxShadow: `inset 0 0 0 1px ${hue}33` }
			}
		>
			{logo ? <span className="flex text-(--text-primary)" dangerouslySetInnerHTML={{ __html: logo }} /> : vendor.replace(/[^a-z0-9]/gi, '').slice(0, 2)}
		</span>
	);
}

/** A gateway's logo and name: OpenRouter, a ChatGPT plan, Claude Code. */
function Provider({ gateway, size = 13 }: { gateway: string; size?: number }) {
	const logo = logoFor({ id: `${gateway}/` });
	return (
		<span className="inline-flex min-w-0 items-center gap-1">
			{logo ? <span aria-hidden className="flex shrink-0" style={{ fontSize: size }} dangerouslySetInnerHTML={{ __html: logo }} /> : null}
			<span className="truncate">{gatewayName(gateway)}</span>
		</span>
	);
}

/** The header's line: the agent's model and gateway, and the others the reply ran on. */
function ReplyModels({ trace, names, when }: { trace: Trace; names: ModelNames; when: string }) {
	const used = modelsUsed(trace);
	const main = used.find((use) => use.model === trace.model) ?? used[0];
	if (!main) return <>Anton · {when}</>;
	const others = used.filter((use) => use !== main);
	return (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			<ModelLogo model={main.model} size={15} />
			<span className="truncate text-(--text-secondary)">{names.name(main.model)}</span>
			<span className="text-(--text-disabled)">via</span>
			<Provider gateway={main.gateway} />
			{others.length ? (
				<HoverPeek
					width={300}
					openDelay={150}
					content={
						<div className="flex flex-col gap-2">
							<Caption>Models this reply ran on</Caption>
							{used.map((use) => (
								<div key={use.model} className="flex items-center gap-2 text-[12px]">
									<ModelLogo model={use.model} size={16} />
									<span className="min-w-0 flex-1 truncate text-(--text-primary)">{names.name(use.model)}</span>
									<span className="in-num text-[11px] text-(--text-tertiary)">
										{use.calls} call{use.calls === 1 ? '' : 's'}
									</span>
								</div>
							))}
						</div>
					}
				>
					<span tabIndex={0} className="inline-flex shrink-0 items-center gap-1 outline-none">
						{others.slice(0, 3).map((use) => (
							<ModelLogo key={use.model} model={use.model} size={15} />
						))}
						<Chip mono>+{others.length} model{others.length === 1 ? '' : 's'}</Chip>
					</span>
				</HoverPeek>
			) : null}
			<span className="text-(--text-disabled)">·</span>
			<span className="shrink-0">{when}</span>
		</span>
	);
}

/** A row's icon: the agent's mark, a subagent's tile, the model's vendor, or what kind of tool it was. */
function RowIcon({ node }: { node: TraceNode }) {
	const span = node.span;
	if (!span) return <Logo size={16} />;
	if (span.kind === 'agent') return <AgentTile agent={span.agent} size={18} />;
	if (span.kind === 'model' && !span.error) {
		return (
			<span className="relative inline-flex shrink-0">
				<ModelLogo model={span.model} size={18} />
				<span className="absolute -right-[2px] -bottom-[2px] size-[7px] rounded-full shadow-[0_0_0_1.5px_var(--pop-bg)]" style={{ background: node.hue }} />
			</span>
		);
	}
	const icon: LucideIcon = span.kind === 'model' ? Sparkles : span.kind === 'compaction' ? FoldVertical : describeTool({ toolName: span.tool, input: parsedInput(span) }).icon;
	return (
		<span
			className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px]"
			style={span.error ? { color: 'var(--danger-text)', background: 'var(--danger-bg)' } : { color: 'var(--icon-secondary)', background: 'var(--alpha-white-6)' }}
		>
			<Icon icon={icon} size={11} />
		</span>
	);
}

/** What a row says: a short name and, dimmer, what it worked on. */
function rowText(node: TraceNode, trace: Trace, names?: ModelNames): { label: ReactNode; sub: string } {
	const span = node.span;
	if (!span) return { label: 'Anton', sub: trace.model ? (names?.name(trace.model) ?? shortModel(trace.model)) : '' };
	switch (span.kind) {
		case 'model': {
			// The model is named only where it differs from the agent's; what the call led to says more.
			const calls = span.output.toolCalls.map((call) => call.name);
			const did = calls.length ? `→ ${calls.length > 2 ? `${calls.slice(0, 2).join(', ')} +${calls.length - 2}` : calls.join(', ')}` : span.output.text ? 'answered' : null;
			return {
				label: span.purpose === 'agent' ? 'Model call' : 'Summarized the conversation',
				sub: [span.model !== trace.model ? (names?.short(span) ?? shortModel(span.model)) : null, did, span.usage ? `${tokens(cacheShare(span.usage).total)} in` : null].filter(Boolean).join(' · '),
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
	line,
	names,
	head,
	slowest,
	switched,
	selected,
	onSelect,
	onToggle,
}: {
	row: TraceRow;
	trace: Trace;
	line: Timeline;
	names: ModelNames;
	head: number | null;
	slowest: string | null;
	switched: ModelChange | null;
	selected: boolean;
	onSelect: () => void;
	onToggle: () => void;
}) {
	const { label, sub } = rowText(row, trace, names);
	const group = row.children.length > 0 || row.group !== null;
	return (
		<div
			data-row={row.key}
			role="treeitem"
			aria-selected={selected}
			aria-level={row.depth + 1}
			aria-expanded={row.children.length ? !row.folded : undefined}
			onClick={onSelect}
			className={cn('group/row relative flex h-[30px] cursor-default transition-colors duration-(--duration-micro)', selected ? 'bg-(--bg-selected)' : 'hover:bg-(--bg-hover)')}
			style={{ width: line.tree + line.outer }}
		>
			<div
				className={cn(
					STICKY,
					'z-[2] flex h-full shrink-0 items-center gap-1.5 pr-2',
					selected ? '[background-image:linear-gradient(var(--bg-selected),var(--bg-selected))]' : 'group-hover/row:[background-image:linear-gradient(var(--bg-hover),var(--bg-hover))]',
					row.match && 'shadow-[inset_2px_0_0_var(--warning-base)]',
				)}
				style={{ width: line.tree, paddingLeft: 10 + row.depth * 16 }}
			>
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
				{switched ? (
					<span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-(--warning-text)" title={`Model changed: ${names.of(switched.from)} → ${names.of(switched.to)}`}>
						<Icon icon={ArrowLeftRight} size={11} />
						{names.short(switched.to)}
					</span>
				) : null}
				{sub ? <span className="min-w-0 flex-1 truncate text-[12px] text-(--text-tertiary)">{sub}</span> : null}
				<ColumnGrip line={line} />
			</div>
			<div className="relative h-full shrink-0" style={{ width: line.outer }}>
				<div className="absolute inset-y-0" style={{ left: LEAD, width: line.width }}>
					<Bar row={row} trace={trace} total={line.total} head={head} slowest={slowest === row.span?.id} />
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

function TraceFooter({ replay, line }: { replay: Replay; line: Timeline }) {
	const total = line.total;
	// The slider moves on a log scale, so each step stretches by the same factor.
	const step = (zoom: number) => Math.round((Math.log(zoom) / Math.log(line.most)) * 1000);
	return (
		<footer className="flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-(--border-subtle) px-3">
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
					<span className="in-num shrink-0 text-[11px] text-(--text-tertiary)">
						{seconds(replay.head)} <span className="text-(--text-disabled)">/ {seconds(total)}</span>
					</span>
					<Btn size="sm" variant="ghost" className="px-2 text-[11.5px] text-(--text-tertiary)" onClick={replay.clear}>
						Show all
					</Btn>
				</>
			) : null}
			<span className="mx-1.5 h-4 w-px shrink-0 bg-(--border-default)" />
			<Segmented label="Timeline width" role="radiogroup" className="shrink-0">
				<SegmentedItem size="sm" role="radio" on={line.zoomPref === 'fit'} onClick={() => line.stretch('fit')} title="Fit the whole reply in view (0)">
					Fit
				</SegmentedItem>
				<SegmentedItem size="sm" role="radio" on={line.zoomPref === 'auto'} onClick={() => line.stretch('auto')} title="Stretch so a typical model call reads">
					Auto
				</SegmentedItem>
			</Segmented>
			<IconBtn icon={Minus} size="xs" label="Narrower timeline (−)" disabled={line.zoom <= 1} onClick={() => line.stretch(line.zoom / 1.5)} />
			<input
				type="range"
				min={0}
				max={1000}
				value={step(line.zoom)}
				aria-label="Timeline width"
				aria-valuetext={`${line.zoom.toFixed(1)} times the width that fits`}
				onChange={(event) => line.stretch(line.most ** (Number(event.target.value) / 1000))}
				className="h-1 w-24 shrink-0 cursor-pointer accent-(--accent-base) sm:w-28"
			/>
			<IconBtn icon={Plus} size="xs" label="Wider timeline (+)" disabled={line.zoom >= line.most} onClick={() => line.stretch(line.zoom * 1.5)} />
			<span className="in-num w-10 shrink-0 text-[11px] text-(--text-tertiary)" title="Times the width that fits the whole reply">
				{line.zoom < 9.95 ? line.zoom.toFixed(1) : Math.round(line.zoom)}×
			</span>
			<span className="flex-1" />
			<div className={cn('hidden shrink-0 items-center gap-3.5 text-[11px] text-(--text-tertiary)', replay.head === null && 'xl:flex')}>
				<Legend swatch={{ background: 'var(--data-1)' }}>Model call</Legend>
				<Legend swatch={{ background: toolFill('var(--data-1)') }}>Tool call</Legend>
				<Legend swatch={hatch('var(--neutral-300)')}>Waiting</Legend>
				<Legend swatch={{ background: 'var(--danger-base)' }}>Failed</Legend>
				<span className="inline-flex items-center gap-1.5 text-(--warning-text)">
					<Icon icon={ArrowLeftRight} size={11} />
					Model changed
				</span>
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

function StepCard({ node, trace, names, onClose, onSelect }: { node: TraceNode; trace: Trace; names: ModelNames; onClose: () => void; onSelect: (key: string) => void }) {
	const span = node.span;
	const { label } = rowText(node, trace, names);
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
				{!span ? <ReplyDetail trace={trace} names={names} onSelect={onSelect} /> : null}
				{span?.kind === 'model' ? <ModelDetail span={span} trace={trace} names={names} onSelect={onSelect} /> : null}
				{span?.kind === 'tool' ? <ToolDetail span={span} trace={trace} onSelect={onSelect} /> : null}
				{span?.kind === 'agent' ? <AgentDetail span={span} trace={trace} names={names} /> : null}
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

function ModelDetail({ span, trace, names, onSelect }: { span: ModelSpan; trace: Trace; names: ModelNames; onSelect: (key: string) => void }) {
	const previous = previousCall(trace, span);
	const changed = previous && (previous.model !== span.model || (previous.served ?? null) !== (span.served ?? null)) ? previous : null;
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
			<div className="flex flex-col gap-2 rounded-[10px] border border-(--border-subtle) bg-(--bg-raised) px-3 py-2.5">
				<div className="flex min-w-0 items-center gap-2">
					<ModelLogo model={span.model} size={20} />
					<div className="flex min-w-0 flex-1 flex-col">
						<span className="truncate text-[12.5px] font-medium text-(--text-primary)">{names.name(span.model)}</span>
						<span className="in-num truncate text-[10.5px] text-(--text-disabled)">{span.served && span.served !== span.model ? `answered by ${span.served}` : span.model}</span>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-(--text-tertiary)">
					<Chip>
						<Provider gateway={gatewayOf(span.model)} size={11} />
					</Chip>
					<Chip mono>call {callNumber(trace, span)}</Chip>
					{span.finish ? <Chip mono>{span.finish}</Chip> : null}
				</div>
				{changed ? (
					<div className="flex items-center gap-1.5 text-[11.5px] text-(--warning-text)">
						<Icon icon={ArrowLeftRight} size={11} />
						<span className="min-w-0 truncate">Changed from {names.of(changed)} on the call before</span>
					</div>
				) : null}
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

function AgentDetail({ span, trace, names }: { span: AgentSpan; trace: Trace; names: ModelNames }) {
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
				<div className="flex flex-wrap items-center gap-1.5">
					<ModelLogo model={model} size={18} />
					<span className="text-[12px] text-(--text-secondary)">{names.name(model)}</span>
					<Chip>
						<Provider gateway={gatewayOf(model)} size={11} />
					</Chip>
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

function ReplyDetail({ trace, names, onSelect }: { trace: Trace; names: ModelNames; onSelect: (key: string) => void }) {
	const stats = traceStats(trace);
	const used = modelsUsed(trace);
	const changes = modelChanges(trace);
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
			<Section title="Models" hint={changes.length ? `changed ${changes.length} time${changes.length === 1 ? '' : 's'}` : undefined}>
				{used.map((use) => (
					<div key={use.model} className="flex items-center gap-2.5 text-[12px]">
						<ModelLogo model={use.model} size={20} />
						<div className="flex min-w-0 flex-1 flex-col">
							<span className="truncate text-(--text-primary)">{names.name(use.model)}</span>
							<span className="flex min-w-0 items-center gap-1 text-[11px] text-(--text-tertiary)">
								<Provider gateway={use.gateway} size={11} />
								{use.served.length ? <span className="in-num truncate text-(--text-disabled)">· {use.served.map(shortModel).join(', ')}</span> : null}
							</span>
						</div>
						<span className="in-num text-right text-[11px] text-(--text-tertiary)">
							{use.calls} call{use.calls === 1 ? '' : 's'}
							<br />
							{tokens(use.tokens)} · {dollars(use.cost)}
						</span>
					</div>
				))}
				{changes.map((change) => (
					<button
						key={change.span}
						type="button"
						onClick={() => onSelect(`model:${change.span}`)}
						className="flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left text-[11.5px] text-(--warning-text) outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
					>
						<Icon icon={ArrowLeftRight} size={11} />
						<span className="min-w-0 truncate">
							+{seconds(change.at)}: {names.short(change.from)} → {names.short(change.to)}
						</span>
					</button>
				))}
			</Section>
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
