import { areaY, barY, defineChart, lineY, ruleY } from '@tanstack/charts';
import { Chart } from '@tanstack/charts/react';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scalePoint } from '@tanstack/charts/scales/point';
import { tooltip } from '@tanstack/charts/tooltip';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/* Charts drawn with TanStack Charts. Each takes rows in the app's own shape
   and memoizes its definition on them, so a refetch with the same data does
   not rebuild the scene. Colours come from the --data-* tokens. */

export const DATA_COLORS = ['var(--data-1)', 'var(--data-2)', 'var(--data-3)', 'var(--data-4)', 'var(--data-5)', 'var(--data-6)'];

const GRID = { stroke: 'currentColor', strokeOpacity: 0.09, strokeDasharray: '2 4' };

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

/** Tick labels for a run of days: the first of each week, so a month reads as four or five marks. */
const weekly = (days: readonly string[]) => days.filter((_, index) => (days.length - 1 - index) % 7 === 0);

export type StackRow = { day: string; series: string; value: number };

/**
 * Bars per day, stacked by series, over a fixed run of days so quiet days
 * still take their place. An optional limit draws as a dashed line once the
 * bars come near it.
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
	const definition = useMemo(() => {
		const totals = new Map<string, number>();
		for (const row of rows) totals.set(row.day, (totals.get(row.day) ?? 0) + row.value);
		const peak = Math.max(0, ...totals.values());
		// A cap far above anything spent would flatten every bar, so it only shows once spend gets within reach of it.
		const showLimit = limit && limit.value > 0 && peak >= limit.value * 0.4;
		const ticks = niceTicks(Math.max(peak, showLimit ? limit.value : 0), whole);
		const top = Math.max(ticks[2], peak * 1.08);
		const filled: StackRow[] = days.flatMap((day) =>
			series.map((name) => ({ day, series: name, value: rows.find((row) => row.day === day && row.series === name)?.value ?? 0 })),
		);
		return defineChart({
			marks: [
				barY(filled, { x: 'day', y: 'value', color: 'series', radius: 2, inset: 0.5 }),
				...(showLimit ? [ruleY([limit.value], { stroke: 'var(--warning-base)', strokeDasharray: '4 4', strokeOpacity: 0.8 })] : []),
			],
			scales: {
				x: {
					scale: () => scaleBand<string>().domain(days).paddingInner(0.28).paddingOuter(0.1),
					axis: { line: false, ticks: { values: weekly(days), size: 0, format: shortDay } },
				},
				y: {
					scale: () => scaleLinear().domain([0, top]),
					grid: GRID,
					axis: { line: false, ticks: { values: ticks, size: 0, format } },
				},
			},
			color: { domain: series, range: colors ?? DATA_COLORS.slice(0, Math.max(1, series.length)) },
			focus: 'group-x',
			tooltip: {
				use: tooltip,
				formatGroup(points) {
					const day = String(points[0]?.xValue ?? '');
					const shown = points.filter((point) => point.datum.value > 0);
					const total = shown.reduce((sum, point) => sum + point.datum.value, 0);
					return [
						`${shortDay(day)} · ${format(total)}`,
						...shown.map((point) => `${point.datum.series}  ${format(point.datum.value)}`),
					].join('\n');
				},
			},
		});
	}, [rows, days, series, format, limit, colors, whole]);
	return (
		<div className={cn('in-chart', className)}>
			<Chart definition={definition} height={height} ariaLabel={label} ariaDescription={description} idPrefix={label.replace(/\W+/g, '-')} />
		</div>
	);
}

/** A small trend line with a soft fill under it, no axes: the shape of the last few weeks. */
export function Sparkline({ values, label, height = 44, color = 'var(--data-1)' }: { values: Array<{ key: string; value: number }>; label: string; height?: number; color?: string }) {
	const id = label.replace(/\W+/g, '-');
	const definition = useMemo(
		() =>
			defineChart({
				marks: [
					areaY(values, { x: 'key', y: 'value', fill: `url(#${id}-fill)`, fillOpacity: 1 }),
					lineY(values, { x: 'key', y: 'value', stroke: color, strokeWidth: 1.5 }),
				],
				scales: {
					x: { scale: () => scalePoint<string>().padding(0), axis: false },
					y: { scale: () => scaleLinear().domain([0, Math.max(...values.map((entry) => entry.value), 0) * 1.15 || 1]), axis: false },
				},
				margin: { top: 2, right: 1, bottom: 1, left: 1 },
				gradients: [
					{
						id: `${id}-fill`,
						x1: 0,
						y1: 0,
						x2: 0,
						y2: 1,
						stops: [
							{ offset: 0, color, opacity: 0.32 },
							{ offset: 1, color, opacity: 0 },
						],
					},
				],
			}),
		[values, color, id],
	);
	return (
		<div className="in-chart">
			<Chart definition={definition} height={height} ariaLabel={label} idPrefix={id} />
		</div>
	);
}
