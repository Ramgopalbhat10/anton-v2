import type { IconComponent } from '@/lib/icons';
import { ArrowLeftRight, ChevronDown, ChevronRight, FoldVertical, ListTree, Sparkles, X, Zap } from '@/lib/icons';
import { type CSSProperties, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HoverPeek } from '@/components/kit/hover-peek';
import { ModelLogo } from '@/components/marks/model-marks';
import { useModels } from '@/lib/models';
import { Logo } from '@/components/marks/illustrations';
import { Caption, Chip, Count, Status, type Tone } from '@/components/kit/instrument';
import { Icon } from '@/components/kit/signal';
import { AgentTile } from '@/components/thread/subagents';
import { lookOf, titleOf } from '@/lib/subagents';
import { describeTool } from '@/components/thread/tool-describe';
import { dollars, tokens } from '@/lib/format';
import { logoFor } from '@/lib/provider-logos';
import {
	autoZoom,
	gatewayName,
	type ModelChange,
	modelsUsed,
	parsedInput,
	previousCall,
	seconds,
	shortModel,
	type TraceNode,
	type TraceRow,
	traceStats,
} from '@/lib/trace-view';
import { useElementSize } from '@/lib/use-element-size';
import { cn } from '@/lib/utils';
import { cacheShare, cacheVerdict, type ModelSpan, type Trace } from '../../../core/trace';

export const TONE_FILL: Record<Tone, string> = {
	neutral: 'var(--text-3)',
	accent: 'var(--accent)',
	attention: 'var(--warn)',
	success: 'var(--ok)',
	warning: 'var(--warn)',
	danger: 'var(--bad)',
};

export const hatch = (hue: string): CSSProperties => ({
	backgroundImage: `repeating-linear-gradient(135deg, color-mix(in oklab, ${hue} 34%, transparent) 0 1.5px, transparent 1.5px 6px)`,
	boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${hue} 30%, transparent)`,
});

export const toolFill = (hue: string) => `color-mix(in oklab, ${hue} 46%, var(--bg-active))`;

const LEAD = 12;

const tail = (narrow: boolean) => (narrow ? 72 : 118);

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

type Zoom = 'fit' | 'auto' | number;

export function useTimeline(trace: Trace) {
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

export type Timeline = ReturnType<typeof useTimeline>;

const pos = (ms: number, total: number) => `${Math.max(0, Math.min(100, (ms / total) * 100))}%`;

/** The steps column's own background, so the timeline scrolls under it; a row's state is laid over it. */
const STICKY = 'sticky left-0 border-r border-(--line) bg-(--bg-overlay)';

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
			<span className="absolute inset-y-0 left-[2.5px] w-px bg-transparent transition-colors duration-(--t-fast) group-hover/grip:bg-(--accent)" />
		</span>
	);
}

export function TimeAxis({
	line,
	ticks,
	changes,
	names,
	count,
}: {
	line: Timeline;
	ticks: number[];
	changes: ModelChange[];
	names: ModelNames;
	count: number;
}) {
	const total = line.total;
	return (
		<div className="sticky top-0 z-[4] flex h-8 border-b border-(--line) bg-(--bg-overlay)">
			<div className={cn(STICKY, 'z-[2] flex shrink-0 items-center gap-1.5 px-4 text-(--text-3)')} style={{ width: line.tree }}>
				<Icon icon={ListTree} size={12} />
				<Caption>Steps</Caption>
				<Count>{count}</Count>
				<ColumnGrip line={line} />
			</div>
			<div className="relative shrink-0" style={{ width: line.outer }}>
				<div className="absolute inset-y-0" style={{ left: LEAD, width: line.width }}>
					{ticks.map((tick) => (
						<span key={tick} className="in-num absolute top-1/2 -translate-y-1/2 pl-1.5 text-micro whitespace-nowrap text-(--text-4)" style={{ left: pos(tick, total) }}>
							{seconds(tick)}
						</span>
					))}
					{changes.map((change) => (
						<span
							key={change.span}
							className="absolute top-1/2 z-[1] flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-(--warn-line) bg-(--bg-overlay) py-px pr-1.5 pl-[3px] text-nano whitespace-nowrap text-(--warn)"
							style={{ left: pos(change.at, total) }}
							title={`Model changed: ${names.of(change.from)} → ${names.of(change.to)}`}
						>
							<ModelLogo model={change.to.model} size={13} />
							{names.short(change.to)}
						</span>
					))}
				</div>
				<StretchGrip line={line} />
			</div>
		</div>
	);
}

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
			<span className="h-4 w-[5px] rounded-full bg-(--bg-surface) transition-colors duration-(--t-fast) group-hover/stretch:border group-hover/stretch:border-(--accent-line) group-hover/stretch:bg-(--accent-soft)" />
		</span>
	);
}

export function GridLines({ line, ticks, changes }: { line: Timeline; ticks: number[]; changes: ModelChange[] }) {
	const total = line.total;
	return (
		<div aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: line.tree + LEAD, width: line.width }}>
			{ticks.map((tick) => (
				<span key={tick} className="absolute inset-y-0 w-px bg-(--grid-line)" style={{ left: pos(tick, total) }} />
			))}
			{changes.map((change) => (
				<span key={change.span} className="absolute inset-y-0 w-0 border-l border-dashed border-(--warn-line)" style={{ left: pos(change.at, total) }} />
			))}
		</div>
	);
}

export type ModelNames = { of: (span: Pick<ModelSpan, 'model' | 'served'>) => string; short: (span: Pick<ModelSpan, 'model' | 'served'>) => string; name: (model: string) => string };

export function useModelNames(): ModelNames {
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

export function Provider({ gateway, size = 13 }: { gateway: string; size?: number }) {
	const logo = logoFor({ id: `${gateway}/` });
	return (
		<span className="inline-flex min-w-0 items-center gap-1">
			{logo ? <span aria-hidden className="flex shrink-0" style={{ fontSize: size }} dangerouslySetInnerHTML={{ __html: logo }} /> : null}
			<span className="truncate">{gatewayName(gateway)}</span>
		</span>
	);
}

export function ReplyModels({ trace, names, when }: { trace: Trace; names: ModelNames; when: string }) {
	const used = modelsUsed(trace);
	const main = used.find((use) => use.model === trace.model) ?? used[0];
	if (!main) return <>Anton · {when}</>;
	const others = used.filter((use) => use !== main);
	return (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			<ModelLogo model={main.model} size={15} />
			<span className="truncate text-(--text-2)">{names.name(main.model)}</span>
			<span className="text-(--text-4)">via</span>
			<Provider gateway={main.gateway} />
			{others.length ? (
				<HoverPeek
					width={300}
					openDelay={150}
					content={
						<div className="flex flex-col gap-2">
							<Caption>Models this reply ran on</Caption>
							{used.map((use) => (
								<div key={use.model} className="flex items-center gap-2 text-small">
									<ModelLogo model={use.model} size={16} />
									<span className="min-w-0 flex-1 truncate text-(--text)">{names.name(use.model)}</span>
									<span className="in-num text-micro text-(--text-3)">
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
			<span className="text-(--text-4)">·</span>
			<span className="shrink-0">{when}</span>
		</span>
	);
}

export function RowIcon({ node }: { node: TraceNode }) {
	const span = node.span;
	if (!span) return <Logo size={16} />;
	if (span.kind === 'agent') return <AgentTile agent={span.agent} size={18} />;
	if (span.kind === 'model' && !span.error) {
		return (
			<span className="relative inline-flex shrink-0">
				<ModelLogo model={span.model} size={18} />
				<span className="absolute -right-[2px] -bottom-[2px] size-[7px] rounded-full shadow-[0_0_0_1.5px_var(--bg-overlay)]" style={{ background: node.hue }} />
			</span>
		);
	}
	const icon: IconComponent = span.kind === 'model' ? Sparkles : span.kind === 'compaction' ? FoldVertical : describeTool({ toolName: span.tool, input: parsedInput(span) }).icon;
	return (
		<span
			className="inline-flex size-[18px] shrink-0 items-center justify-center"
			style={{ color: span.error ? 'var(--bad)' : 'var(--text-3)' }}
		>
			<Icon icon={icon} size={13} />
		</span>
	);
}

export function rowText(node: TraceNode, trace: Trace, names?: ModelNames): { label: ReactNode; sub: string } {
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

export function StepRow({
	row,
	trace,
	line,
	names,
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
			className={cn('group/row relative flex h-[30px] cursor-default transition-colors duration-(--t-fast)', selected ? 'bg-(--bg-active)' : 'hover:bg-(--bg-hover)')}
			style={{ width: line.tree + line.outer }}
		>
			<div
				className={cn(
					STICKY,
					'z-[2] flex h-full shrink-0 items-center gap-1.5 pr-2',
					selected ? '[background-image:linear-gradient(var(--bg-active),var(--bg-active))]' : 'group-hover/row:[background-image:linear-gradient(var(--bg-hover),var(--bg-hover))]',
					row.match && 'shadow-[inset_2px_0_0_var(--warn)]',
				)}
				style={{ width: line.tree, paddingLeft: 10 + row.depth * 16 }}
			>
				{Array.from({ length: row.depth }, (_, level) => (
					<span key={level} aria-hidden className="absolute inset-y-0 w-px bg-(--line)" style={{ left: 18 + level * 16 }} />
				))}
				{row.children.length ? (
					<button
						type="button"
						aria-label={row.folded ? 'Show its steps' : 'Hide its steps'}
						onClick={(event) => {
							event.stopPropagation();
							onToggle();
						}}
						className="inline-flex size-4 shrink-0 items-center justify-center rounded-control text-(--text-3) outline-none hover:bg-(--bg-active) hover:text-(--text) focus-visible:shadow-(--focus)"
					>
						<Icon icon={row.folded ? ChevronRight : ChevronDown} size={12} />
					</button>
				) : (
					<span className="w-4 shrink-0" />
				)}
				<RowIcon node={row} />
				<span className={cn('min-w-0 shrink truncate text-body', row.span?.error ? 'text-(--bad)' : 'text-(--text)', group && 'font-medium')}>{label}</span>
				{switched ? (
					<span className="inline-flex shrink-0 items-center gap-1 text-micro text-(--warn)" title={`Model changed: ${names.of(switched.from)} → ${names.of(switched.to)}`}>
						<Icon icon={ArrowLeftRight} size={11} />
						{names.short(switched.to)}
					</span>
				) : null}
				{sub ? <span className="min-w-0 flex-1 truncate text-small text-(--text-3)">{sub}</span> : null}
				<ColumnGrip line={line} />
			</div>
			<div className="relative h-full shrink-0" style={{ width: line.outer }}>
				<div className="absolute inset-y-0" style={{ left: LEAD, width: line.width }}>
					<Bar row={row} trace={trace} total={line.total} slowest={slowest === row.span?.id} />
				</div>
			</div>
		</div>
	);
}

function Bar({ row, trace, total, slowest }: { row: TraceRow; trace: Trace; total: number; slowest: boolean }) {
	const span = row.span;
	const duration = Math.max(0, row.end - row.start);
	const end = row.start + duration;
	// The label goes after the bar, into the room kept right of the track, unless a long one would run off it.
	const nearEnd = end / total > 0.9 && row.start / total > 0.35;
	const width = (ms: number) => `max(3px, ${(ms / total) * 100}%)`;
	const failed = Boolean(span?.error);
	const fill = failed ? 'var(--bad)' : span?.kind === 'model' ? row.hue : span?.kind === 'compaction' ? 'var(--warn)' : toolFill(row.hue);
	// A group's bar is hatched while it waits on its own calls and subagents, solid where it called its model.
	const own = row.group ? trace.spans.filter((other): other is ModelSpan => other.kind === 'model' && other.lane === row.group) : [];
	const verdict = span?.kind === 'model' ? cacheVerdict(span, previousCall(trace, span)) : null;
	const cost = span?.kind === 'model' ? (span.usage?.cost ?? 0) : row.group ? traceStats(trace, row.group === 'main' ? undefined : row.group).cost : 0;
	return (
		<>
			{row.group ? (
				<div className="absolute top-1/2 h-3.5 -translate-y-1/2 overflow-hidden rounded-control" style={{ left: pos(row.start, total), width: width(duration), ...hatch(row.hue) }}>
					{own.map((call) => (
						<span
							key={call.id}
							className="absolute inset-y-0 rounded-mark"
							style={{
								left: `${((call.start - row.start) / Math.max(duration, 1)) * 100}%`,
								width: `max(3px, ${(call.durationMs / Math.max(duration, 1)) * 100}%)`,
								background: call.error ? 'var(--bad)' : row.hue,
							}}
						/>
					))}
				</div>
			) : (
				<div
					className={cn('absolute top-1/2 flex h-3.5 -translate-y-1/2 items-center justify-center rounded-control', span?.kind === 'compaction' && 'opacity-80')}
					style={{ left: pos(row.start, total), width: width(duration), background: fill }}
				>
					{failed && duration / total > 0.02 ? <Icon icon={X} size={10} className="text-(--accent-fg)" /> : null}
				</div>
			)}
			<span
				className="in-num absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-micro whitespace-nowrap text-(--text-3)"
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
		</>
	);
}
