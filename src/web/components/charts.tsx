import { type KeyboardEvent, type ReactNode, useId, useMemo, useState } from 'react';
import { useElementSize } from '@/lib/use-element-size';
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
	const [box, { width }] = useElementSize<HTMLDivElement>();
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

/**
 * Days as a dot matrix: a column of small cells per day, lit from the bottom
 * in proportion to the busiest day, brightest at the top of each column. Quiet
 * days keep their unlit column, so a month of little use still reads as a
 * month. The busiest day is labelled; hover a day, or focus the matrix and use
 * the arrow keys, to read it.
 */
export function DotMatrix({
	values,
	label,
	format,
	rows = 7,
	color = 'var(--accent-base)',
	className,
}: {
	values: Array<{ key: string; value: number }>;
	label: string;
	format: (value: number) => string;
	rows?: number;
	color?: string;
	className?: string;
}) {
	const [box, { width }] = useElementSize<HTMLDivElement>();
	const [active, setActive] = useState<number | null>(null);
	const cols = values.length;
	// The cells fill the width, up to a size, with gaps that shrink along with them.
	const gap = width / Math.max(1, cols) < 9 ? 1.5 : 2;
	const cell = cols ? Math.max(3, Math.min(14, (width - (cols - 1) * gap) / cols)) : 0;
	const matrixW = cols * cell + (cols - 1) * gap;
	const left = Math.max(0, (width - matrixW) / 2);
	const top = 16;
	const matrixH = rows * cell + (rows - 1) * gap;
	const height = top + matrixH + 20;
	const peak = Math.max(0, ...values.map((entry) => entry.value));
	const peakIndex = peak > 0 ? values.findIndex((entry) => entry.value === peak) : -1;
	const lit = (value: number) => (value > 0 && peak > 0 ? Math.max(1, Math.round((value / peak) * rows)) : 0);
	const x = (index: number) => left + index * (cell + gap);
	const y = (row: number) => top + matrixH - (row + 1) * cell - row * gap;
	const current = active === null ? null : values[active];

	function onKeyDown(event: KeyboardEvent) {
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (event.key === 'Escape') setActive(null);
		if (!step) return;
		event.preventDefault();
		setActive((index) => Math.min(cols - 1, Math.max(0, index === null ? cols - 1 : index + step)));
	}

	return (
		<div
			ref={box}
			role="figure"
			aria-label={label}
			tabIndex={0}
			onKeyDown={onKeyDown}
			onBlur={() => setActive(null)}
			onPointerLeave={() => setActive(null)}
			className={cn('in-chart relative outline-none focus-visible:rounded-[8px] focus-visible:shadow-(--focus-ring)', className)}
			style={{ height }}
		>
			{width > 0 && cols ? (
				<svg width={width} height={height} aria-hidden className="block overflow-visible">
					{values.map((entry, index) => {
						const on = lit(entry.value);
						const today = index === cols - 1;
						const dim = active !== null && active !== index;
						return (
							<g key={entry.key} opacity={dim ? 0.4 : 1} style={{ transition: 'opacity 120ms' }}>
								<rect x={x(index) - gap / 2} y={0} width={cell + gap} height={height} fill="transparent" onPointerEnter={() => setActive(index)} />
								{Array.from({ length: rows }, (_, row) => {
									const isLit = row < on;
									// Lit cells brighten towards the top of the column.
									const opacity = isLit ? 0.35 + 0.65 * ((row + 1) / on) : today ? 0.16 : 0.08;
									return (
										<rect
											key={row}
											x={x(index)}
											y={y(row)}
											width={cell}
											height={cell}
											rx={Math.max(1, cell * 0.28)}
											fill={isLit ? color : 'currentColor'}
											fillOpacity={opacity}
											pointerEvents="none"
										/>
									);
								})}
								{on > 0 && (active === index || (active === null && index === peakIndex)) ? (
									<text x={x(index) + cell / 2} y={y(on - 1) - 5} textAnchor="middle" fill="var(--text-secondary)" pointerEvents="none">
										{format(entry.value)}
									</text>
								) : null}
							</g>
						);
					})}
					<text x={left} y={height - 4} fill="currentColor">
						{shortDay(values[0].key)}
					</text>
					<text x={left + matrixW} y={height - 4} textAnchor="end" fill="var(--text-secondary)">
						Today
					</text>
				</svg>
			) : null}
			<div aria-live="polite" className="sr-only">
				{current ? `${shortDay(current.key)}: ${format(current.value)}` : ''}
			</div>
			{current && active !== null && lit(current.value) === 0 ? (
				<div
					className="in-pop pointer-events-none absolute z-10 px-2 py-1 text-[11px] whitespace-nowrap"
					style={{ left: Math.min(Math.max(x(active) + cell / 2, 50), width - 50), top: y(0) - 6, transform: 'translate(-50%, -100%)' }}
				>
					<span className="text-(--text-tertiary)">{shortDay(current.key)}</span> <span className="in-num text-(--text-secondary)">{format(current.value)}</span>
				</div>
			) : null}
		</div>
	);
}

/**
 * A dial of ticks around 220 degrees: lit from the start up to the value, a
 * warning band near the end, and a bright mark riding the arc where the value
 * is. The middle holds whatever matters most about it.
 */
export function ArcDial({
	value,
	max,
	warnAt = 0.8,
	label,
	children,
	size = 132,
	ticks = 44,
}: {
	value: number;
	max: number;
	/** Where the warning band starts, as a share of `max`. */
	warnAt?: number;
	label: string;
	children?: ReactNode;
	size?: number;
	ticks?: number;
}) {
	const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
	const sweep = 220;
	const start = 90 + sweep / 2;
	const cx = size / 2;
	const cy = size / 2;
	const outer = size / 2 - 4;
	const point = (t: number, radius: number) => {
		const angle = ((start - t * sweep) * Math.PI) / 180;
		return [cx + radius * Math.cos(angle), cy - radius * Math.sin(angle)] as const;
	};
	const [mx, my] = point(fraction, outer - 6);
	const height = Math.ceil(cy + outer * Math.sin(((sweep / 2 - 90) * Math.PI) / 180) + 6);
	return (
		<div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="relative shrink-0" style={{ width: size, height }}>
			<svg width={size} height={height} aria-hidden className="block overflow-visible">
				{Array.from({ length: ticks + 1 }, (_, index) => {
					const t = index / ticks;
					const major = index % 11 === 0;
					const [x1, y1] = point(t, outer - (major ? 12 : 9));
					const [x2, y2] = point(t, outer);
					const warn = t >= warnAt;
					const on = fraction > 0 && t <= fraction;
					const stroke = t >= 1 ? 'var(--danger-base)' : warn ? 'var(--warning-base)' : on ? 'var(--accent-base)' : 'var(--tick-off)';
					// The lit run fades in towards the value, like a trail behind it.
					const opacity = on ? 0.45 + 0.55 * (t / Math.max(fraction, 1e-6)) : warn ? 0.45 : major ? 1 : 0.75;
					return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeOpacity={opacity} strokeWidth={major ? 1.5 : 1} strokeLinecap="round" />;
				})}
				<circle cx={mx} cy={my} r={6} fill="var(--accent-base)" fillOpacity={0.18} />
				<circle cx={mx} cy={my} r={2.5} fill="var(--accent-base)" />
			</svg>
			<div className="absolute inset-x-0 flex flex-col items-center gap-0.5" style={{ top: cy - 16 }}>
				{children}
			</div>
		</div>
	);
}
