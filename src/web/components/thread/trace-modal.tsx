import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, CircleAlert, Minus, Plus, X, Zap } from '@/lib/icons';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TraceIcon } from '@/components/marks/trace-icon';
import { IconTile, Segmented, SegmentedItem, type Tone } from '@/components/kit/instrument';
import { Icon, IconBtn, Kbd, SearchField, Spinner } from '@/components/kit/signal';
import { api } from '@/lib/api';
import { dollars, tokens } from '@/lib/format';
import {
	modelChanges,
	seconds,
	timeTicks,
	type TraceNode,
	traceRows,
	traceStats,
	traceTree,
} from '@/lib/trace-view';
import { cn } from '@/lib/utils';
import { type Trace } from '../../../core/trace';
import { GridLines, hatch, ReplyModels, StepRow, TimeAxis, type Timeline, TONE_FILL, toolFill, useModelNames, useTimeline } from '@/components/thread/trace-timeline';
import { StepCard, TONE_TEXT } from '@/components/thread/trace-details';

export function TraceModal({ sessionId, traceId, onClose }: { sessionId: string; traceId: string; onClose: () => void }) {
	const trace = useQuery({ queryKey: ['trace', sessionId, traceId], queryFn: () => api.trace(sessionId, traceId), staleTime: Infinity, retry: 1 });
	return createPortal(
		<div
			className="fixed inset-0 z-[150] flex items-center justify-center bg-(--bg-scrim) p-2 sm:p-6"
			onMouseDown={(event) => event.target === event.currentTarget && onClose()}
		>
			<div role="dialog" aria-modal="true" aria-label="Reply trace" className="in-pop in-pop--modal flex h-[min(820px,100%)] w-[min(1240px,100%)] flex-col overflow-hidden">
				{trace.data ? (
					<TraceView trace={trace.data} onClose={onClose} />
				) : (
					<>
						<TraceHeader sub={null} onClose={onClose} />
						<div className="flex flex-1 items-center justify-center gap-2 text-body text-(--text-3)">
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
		<header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-(--line) px-4">
			<IconTile icon={TraceIcon} tone="accent" />
			<div className="flex min-w-0 flex-1 items-baseline gap-1.5">
				<h2 className="m-0 shrink-0 text-body-lg font-medium text-(--text)">Trace</h2>
				{sub ? (
					<>
						<span className="text-small text-(--text-4)">/</span>
						<span className="min-w-0 truncate text-small text-(--text-3)">{sub}</span>
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
	const changes = useMemo(() => modelChanges(trace), [trace]);
	const names = useModelNames();
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
	const [query, setQuery] = useState('');
	const rows = useMemo(() => traceRows(tree, folded, query), [tree, folded, query]);
	const [selected, setSelected] = useState<string | null>(null);
	const picked = useMemo(() => (selected ? findNode(tree, selected) : null), [tree, selected]);
	const search = useRef<HTMLInputElement>(null);
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
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [rows, selected, query, onClose, select, toggle, line]);

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

	// As many time marks as fit their labels, about one per 80px of track.
	const ticks = useMemo(() => timeTicks(total, Math.max(2, Math.floor(line.width / 80))), [total, line.width]);
	const when = new Date(trace.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

	return (
		<>
			<TraceHeader sub={<ReplyModels trace={trace} names={names} when={when} />} onClose={onClose}>
				<SearchField
					inputRef={search}
					value={query}
					onChange={setQuery}
					placeholder="Search steps, inputs, outputs"
					label="Search the trace"
					trailing={<Kbd keys="mod+f" size="sm" />}
					className="hidden w-[260px] sm:flex"
				/>
			</TraceHeader>
			<TraceStatsRow stats={stats} trace={trace} />
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div ref={line.bind} role="tree" aria-label="Steps" className="trace-scroll relative min-h-0 flex-1 overflow-auto overscroll-contain">
					<div className="relative min-h-full" style={{ width: line.tree + line.outer }}>
						<TimeAxis line={line} ticks={ticks} changes={changes} names={names} count={trace.spans.length} />
						<div className="relative">
							<GridLines line={line} ticks={ticks} changes={changes} />
							{rows.map((row) => (
								<StepRow
									key={row.key}
									row={row}
									trace={trace}
									line={line}
									names={names}
									slowest={stats.slowest}
									switched={changes.find((change) => change.span === row.span?.id) ?? null}
									selected={row.key === selected}
									onSelect={() => select(row.key === selected ? null : row.key)}
									onToggle={() => toggle(row.key)}
								/>
							))}
						</div>
						{rows.length === 0 ? (
							<div className="sticky left-0 px-4 py-6 text-body text-(--text-3)" style={{ width: line.tree + line.fit }}>
								No step matches “{query}”.
							</div>
						) : null}
						{trace.dropped ? (
							<div className="sticky left-0 px-4 py-3 text-small text-(--text-4)" style={{ width: line.tree + line.fit }}>
								{trace.dropped} later steps weren't kept: a trace keeps its first 600.
							</div>
						) : null}
					</div>
				</div>
				{picked ? <StepCard node={picked} trace={trace} names={names} onClose={() => setSelected(null)} onSelect={select} /> : null}
			</div>
			<TraceFooter line={line} />
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
		<div className="grid shrink-0 grid-cols-4 border-b border-(--line) sm:grid-cols-7" aria-label={`Trace of a reply on ${trace.model ?? 'a model'}`}>
			{items.map((item, index) => (
				<div key={item.label} title={item.title} className={cn('flex min-w-0 flex-col gap-1 px-3 py-2.5 sm:px-4', index > 0 && 'sm:border-l sm:border-(--line)', index >= 4 && 'max-sm:hidden')}>
					<span className="truncate text-micro text-(--text-3)">{item.label}</span>
					<span className={cn('in-figure truncate text-h3 leading-[22px] sm:text-h2 sm:leading-[24px]', item.tone && TONE_TEXT[item.tone])}>{item.value}</span>
					{item.note ? <span className="in-num truncate text-micro text-(--text-4)">{item.note}</span> : <span className="h-[15px]" />}
				</div>
			))}
		</div>
	);
}

function TraceFooter({ line }: { line: Timeline }) {
	// The slider moves on a log scale, so each step stretches by the same factor.
	const step = (zoom: number) => Math.round((Math.log(zoom) / Math.log(line.most)) * 1000);
	return (
		<footer className="flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-(--line) px-3">
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
				className="h-1 w-24 shrink-0 cursor-pointer accent-(--accent) sm:w-28"
			/>
			<IconBtn icon={Plus} size="xs" label="Wider timeline (+)" disabled={line.zoom >= line.most} onClick={() => line.stretch(line.zoom * 1.5)} />
			<span className="in-num w-10 shrink-0 text-micro text-(--text-3)" title="Times the width that fits the whole reply">
				{line.zoom < 9.95 ? line.zoom.toFixed(1) : Math.round(line.zoom)}×
			</span>
			<span className="flex-1" />
			<div className="hidden shrink-0 items-center gap-3.5 text-micro text-(--text-3) lg:flex">
				<Legend swatch={{ background: 'var(--data-1)' }}>Model call</Legend>
				<Legend swatch={{ background: toolFill('var(--data-1)') }}>Tool call</Legend>
				<Legend swatch={hatch('var(--text-2)')}>Waiting</Legend>
				<Legend swatch={{ background: 'var(--bad)' }}>Failed</Legend>
				<span className="inline-flex items-center gap-1.5 text-(--warn)">
					<Icon icon={ArrowLeftRight} size={11} />
					Model changed
				</span>
				<span className="h-3 w-px bg-(--line-strong)" />
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
			<span className="h-2 w-3.5 rounded-mark" style={swatch} />
			{children}
		</span>
	);
}

export function TraceButton({ onOpen }: { onOpen: () => void }) {
	return <IconBtn size="xs" icon={TraceIcon} label="Trace this reply" onClick={onOpen} />;
}
