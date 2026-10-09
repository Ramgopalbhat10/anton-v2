import { type KeyboardEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/* Charts drawn as plain SVG in the instrument style: thin dashed guides,
   mono labels, bars with a soft top, the peak picked out, and one tooltip
   that follows the pointer or the arrow keys. Colours come from the
   --data-* tokens. */

export const DATA_COLORS = ['var(--data-1)', 'var(--data-2)', 'var(--data-3)', 'var(--data-4)', 'var(--data-5)', 'var(--data-6)'];

/** A local date as `YYYY-MM-DD`, the key the usage view's days use. */
export function dayKey(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD` for each of the `count` days ending today, oldest first. */
export function lastDays(count: number, now = new Date()): string[] {
	return Array.from({ length: count }, (_, index) => {
		const day = new Date(now);
		day.setHours(12, 0, 0, 0);
		day.setDate(day.getDate() - (count - 1 - index));
		return dayKey(day);
	});
}

/** "Oct 7" for a `YYYY-MM-DD` key. */
export function shortDay(key: string): string {
	const [year, month, day] = key.split('-').map(Number);
	return new Date(year, month - 1, day).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Three round values from zero up past `top`: 0, a step and two steps, the
 * step a 1, 2 or 5 times a power of ten. Counts keep whole-number steps.
 */
export function niceTicks(top: number, whole = false): number[] {
	const raw = Math.max(top, whole ? 2 : Number.EPSILON) / 2;
	const power = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 5, 10].map((factor) => factor * power).find((value) => value >= raw) ?? raw;
	const rounded = whole ? Math.max(1, Math.ceil(step)) : step;
	return [0, rounded, rounded * 2];
}

/** The width of the element `ref` is on, kept up to date. */
function useWidth<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, width] as const;
}

export type StackRow = { day: string; series: string; value: number };

/** Room for the y labels on the left and the day labels below. */
const GUTTER = { left: 46, right: 6, top: 18, bottom: 22 };

/**
 * Bars per day, stacked by series, over a fixed run of days so quiet days
 * still take their place. The busiest day is labelled; an optional limit
 * draws as a dashed line once the bars come near it. Hover a day, or focus
 * the chart and use the arrow keys, to read it.
 */
export function StackedDaysChart({
	rows,
	days,
	series,
	format,
	label,
	description,
	limit,
	colors,
	whole,
	height = 168,
	className,
}: {
	rows: StackRow[];
	days: string[];
	/** Series in stacking order, bottom first; each takes the next data colour. */
	series: string[];
	format: (value: number) => string;
	label: string;
	description?: string;
	limit?: { value: number; label: string } | null;
	/** A colour per series, when the series mean something (states, say) the data palette would not match. */
	colors?: string[];
	/** The values are counts, so ticks stay on whole numbers. */
	whole?: boolean;
	height?: number;
	className?: string;
}) {
	const [box, width] = useWidth<HTMLDivElement>();
	const [active, setActive] = useState<number | null>(null);
	const id = useId();
	const palette = colors ?? DATA_COLORS;
	const colorOf = (name: string) => palette[series.indexOf(name) % palette.length] ?? palette[0];

	const model = useMemo(() => {
		const byDay = days.map((day) => {
			const parts = series.map((name) => ({ series: name, value: rows.filter((row) => row.day === day && row.series === name).reduce((sum, row) => sum + row.value, 0) }));
			return { day, parts, total: parts.reduce((sum, part) => sum + part.value, 0) };
		});
		const peak = Math.max(0, ...byDay.map((entry) => entry.total));
		// A cap far above anything spent would flatten every bar, so it only shows once spend gets within reach of it.
		const showLimit = Boolean(limit && limit.value > 0 && peak >= limit.value * 0.4);
		const ticks = niceTicks(Math.max(peak, showLimit && limit ? limit.value : 0), whole);
		const top = Math.max(ticks[2], peak * 1.08) || 1;
		const peakIndex = peak > 0 ? byDay.findIndex((entry) => entry.total === peak) : -1;
		return { byDay, ticks, top, showLimit, peakIndex };
	}, [rows, days, series, limit, whole]);

	const plotW = Math.max(0, width - GUTTER.left - GUTTER.right);
	const plotH = Math.max(0, height - GUTTER.top - GUTTER.bottom);
	const band = days.length ? plotW / days.length : 0;
	const barW = Math.max(2, Math.min(22, band * 0.62));
	const y = (value: number) => GUTTER.top + plotH - (value / model.top) * plotH;
	const x = (index: number) => GUTTER.left + band * index + band / 2;
	const shown = active ?? null;
	const current = shown === null ? null : model.byDay[shown];

	function onKeyDown(event: KeyboardEvent) {
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (event.key === 'Escape') setActive(null);
		if (!step) return;
		event.preventDefault();
		setActive((index) => Math.min(days.length - 1, Math.max(0, (index ?? days.length - 1) + (index === null ? 0 : step))));
	}

	return (
		<div
			ref={box}
			role="figure"
			aria-label={label}
			aria-description={description}
			tabIndex={0}
			onKeyDown={onKeyDown}
			onBlur={() => setActive(null)}
			onPointerLeave={() => setActive(null)}
			className={cn('in-chart relative outline-none focus-visible:rounded-[8px] focus-visible:shadow-(--focus-ring)', className)}
			style={{ height }}
		>
			{width > 0 ? (
				<svg width={width} height={height} aria-hidden className="block overflow-visible">
					<defs>
						<linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#fff" stopOpacity="0.22" />
							<stop offset="0.35" stopColor="#fff" stopOpacity="0" />
						</linearGradient>
					</defs>
					{model.ticks.map((tick) => (
						<g key={tick}>
							<line x1={GUTTER.left} x2={GUTTER.left + plotW} y1={y(tick)} y2={y(tick)} stroke="currentColor" strokeOpacity={tick === 0 ? 0.18 : 0.08} strokeDasharray={tick === 0 ? undefined : '2 4'} />
							<text x={GUTTER.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" fill="currentColor">
								{format(tick)}
							</text>
						</g>
					))}
					{model.showLimit && limit ? (
						<g>
							<line x1={GUTTER.left} x2={GUTTER.left + plotW} y1={y(limit.value)} y2={y(limit.value)} stroke="var(--warning-base)" strokeOpacity={0.8} strokeDasharray="4 4" />
							<text x={GUTTER.left + plotW} y={y(limit.value) - 5} textAnchor="end" fill="var(--warning-text)">
								{limit.label} {format(limit.value)}
							</text>
						</g>
					) : null}
					{model.byDay.map((entry, index) => {
						const dim = shown !== null && shown !== index;
						let base = 0;
						const visible = entry.parts.filter((part) => part.value > 0);
						return (
							<g key={entry.day} opacity={dim ? 0.38 : 1} style={{ transition: 'opacity 120ms' }}>
								{/* The whole column answers the pointer, so thin bars are easy to hit. */}
								<rect x={x(index) - band / 2} y={GUTTER.top} width={band} height={plotH} fill="transparent" onPointerEnter={() => setActive(index)} />
								{shown === index ? <rect x={x(index) - band / 2 + 1} y={GUTTER.top} width={band - 2} height={plotH} rx={4} fill="currentColor" fillOpacity={0.05} pointerEvents="none" /> : null}
								{entry.total === 0 ? (
									<rect x={x(index) - barW / 2} y={y(0) - 2} width={barW} height={2} rx={1} fill="var(--segment-off)" pointerEvents="none" />
								) : (
									visible.map((part, partIndex) => {
										const from = y(base);
										base += part.value;
										const to = y(base);
										const last = partIndex === visible.length - 1;
										// One pixel between stacked parts, and a rounded top on the last.
										const h = Math.max(1, from - to - (last ? 0 : 1));
										return (
											<g key={part.series} pointerEvents="none">
												<rect x={x(index) - barW / 2} y={to} width={barW} height={h} rx={last ? 2.5 : 0.5} fill={colorOf(part.series)} />
												{last ? <rect x={x(index) - barW / 2} y={to} width={barW} height={Math.min(h, 10)} rx={2.5} fill={`url(#${id}-sheen)`} /> : null}
											</g>
										);
									})
								)}
								{index === model.peakIndex && shown === null ? (
									<text x={x(index)} y={y(entry.total) - 6} textAnchor="middle" fill="var(--text-secondary)" pointerEvents="none">
										{format(entry.total)}
									</text>
								) : null}
							</g>
						);
					})}
					{days.map((day, index) =>
						(days.length - 1 - index) % 7 === 0 ? (
							<text key={day} x={x(index)} y={height - 6} textAnchor="middle" fill={index === days.length - 1 ? 'var(--text-secondary)' : 'currentColor'}>
								{index === days.length - 1 ? 'Today' : shortDay(day)}
							</text>
						) : null,
					)}
				</svg>
			) : null}
			<div aria-live="polite" className="sr-only">
				{current ? `${shortDay(current.day)}: ${format(current.total)}` : ''}
			</div>
			{current && shown !== null ? (
				<div
					className="in-pop pointer-events-none absolute z-10 flex min-w-[140px] flex-col gap-1 px-2.5 py-2 text-[11px]"
					style={{
						left: Math.min(Math.max(x(shown), 80), width - 80),
						top: Math.max(0, y(current.total) - 8),
						transform: 'translate(-50%, -100%)',
					}}
				>
					<div className="flex items-baseline justify-between gap-3">
						<span className="text-(--text-tertiary)">{shortDay(current.day)}</span>
						<span className="in-num text-(--text-primary)">{format(current.total)}</span>
					</div>
					{current.parts
						.filter((part) => part.value > 0)
						.reverse()
						.map((part) => (
							<div key={part.series} className="flex items-center gap-1.5">
								<span className="size-1.5 shrink-0 rounded-[2px]" style={{ background: colorOf(part.series) }} />
								<span className="min-w-0 flex-1 truncate text-(--text-secondary)">{part.series}</span>
								<span className="in-num text-(--text-tertiary)">{format(part.value)}</span>
							</div>
						))}
				</div>
			) : null}
		</div>
	);
}

/** A small trend line with a soft fill under it, no axes, ending in a dot: the shape of the last few weeks. */
export function Sparkline({ values, label, height = 44, color = 'var(--data-1)' }: { values: Array<{ key: string; value: number }>; label: string; height?: number; color?: string }) {
	const [box, width] = useWidth<HTMLDivElement>();
	const id = useId();
	const top = Math.max(...values.map((entry) => entry.value), 0) * 1.15 || 1;
	const points = values.map((entry, index) => [values.length > 1 ? (index / (values.length - 1)) * (width - 4) + 2 : width / 2, height - 3 - (entry.value / top) * (height - 6)] as const);
	const line = points.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
	const last = points[points.length - 1];
	return (
		<div ref={box} role="img" aria-label={label} className="in-chart" style={{ height }}>
			{width > 0 && points.length ? (
				<svg width={width} height={height} aria-hidden className="block overflow-visible">
					<defs>
						<linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor={color} stopOpacity="0.3" />
							<stop offset="1" stopColor={color} stopOpacity="0" />
						</linearGradient>
					</defs>
					<path d={`${line} L${last[0].toFixed(1)} ${height} L${points[0][0].toFixed(1)} ${height} Z`} fill={`url(#${id}-fill)`} />
					<path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
					<circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />
					<circle cx={last[0]} cy={last[1]} r={5} fill={color} fillOpacity={0.2} />
				</svg>
			) : null}
		</div>
	);
}
