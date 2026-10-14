import { type KeyboardEvent, useMemo, useState } from "react";
import {
  formatValue,
  type UiCell,
  type UiFormat,
  type UiNode,
} from "../../core/ui-spec";
import { useElementSize } from "@/lib/use-element-size";
import { cn } from "@/lib/utils";

/*
 * The charts a reply's `show` card draws, in the instrument style of the
 * Usage charts: hairline guides, mono labels, thin bars with a rounded end,
 * 2px lines, one tooltip that follows the pointer or the arrow keys, and a
 * legend whenever there is more than one series. Series take the data
 * colours in a fixed order; a donut's slices do the same, past five folded
 * into "Other".
 */

type ChartNode = Extract<UiNode, { type: "chart" }>;

/** Series colours in their fixed order; the sixth data colour is grey and stays for "Other". */
const SERIES = [
  "var(--data-1)",
  "var(--data-2)",
  "var(--data-3)",
  "var(--data-4)",
  "var(--data-5)",
];
const OTHER = "var(--data-6)";

const GUTTER = { left: 44, right: 8, top: 14, bottom: 24 };
const HEIGHT = 200;

const num = (value: UiCell | undefined) =>
  typeof value === "number"
    ? value
    : typeof value === "string" &&
        value.trim() &&
        Number.isFinite(Number(value))
      ? Number(value)
      : null;

/** Three or four round ticks across [low, high], the step a 1, 2 or 5 times a power of ten. */
export function rangeTicks(low: number, high: number): number[] {
  const span = high - low || Math.abs(high) || 1;
  const raw = span / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 5, 10]
      .map((factor) => factor * power)
      .find((value) => value >= raw) ?? raw;
  const ticks: number[] = [];
  for (
    let tick = Math.floor(low / step) * step;
    tick <= high + step * 1e-9;
    tick += step
  )
    ticks.push(Math.round(tick / step) * step);
  if (ticks[ticks.length - 1] < high)
    ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** Large numbers short on the axis: 1.2K, 3M. */
function axisLabel(value: number, format?: UiFormat): string {
  if (format === "percent" || format === "currency" || format === "duration")
    return formatValue(value, format);
  const size = Math.abs(value);
  if (size >= 1e9) return `${+(value / 1e9).toFixed(1)}B`;
  if (size >= 1e6) return `${+(value / 1e6).toFixed(1)}M`;
  if (size >= 1e3) return `${+(value / 1e3).toFixed(1)}K`;
  return `${+value.toFixed(2)}`;
}

function Legend({
  items,
}: {
  items: Array<{ label: string; color: string; value?: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-(--text-secondary)">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            className="size-2 shrink-0 rounded-[2px]"
            style={{ background: item.color }}
          />
          {item.label}
          {item.value ? (
            <span className="in-num text-(--text-tertiary)">{item.value}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/** A path for a bar with a rounded end away from the baseline and a square foot on it. */
function barPath(
  x: number,
  width: number,
  from: number,
  to: number,
  round: boolean,
): string {
  const up = to < from;
  const height = Math.abs(from - to);
  const r = round ? Math.min(4, width / 2, height) : 0;
  const top = Math.min(from, to);
  const bottom = Math.max(from, to);
  if (!r) return `M${x},${top}h${width}v${height}h${-width}Z`;
  return up
    ? `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${bottom}Z`
    : `M${x},${top}H${x + width}V${bottom - r}Q${x + width},${bottom} ${x + width - r},${bottom}H${x + r}Q${x},${bottom} ${x},${bottom - r}Z`;
}

function CartesianChart({ node }: { node: ChartNode }) {
  const [box, { width }] = useElementSize<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const stacked = node.kind === "stacked-bar";
  const bars = node.kind === "bar" || stacked;
  const series = node.series.slice(0, SERIES.length);
  const labels = node.data.map((row) => String(row[node.x] ?? ""));
  const values = node.data.map((row) =>
    series.map((item) => num(row[item.key])),
  );

  const domain = useMemo(() => {
    const totals = values.map((row) =>
      stacked
        ? [
            row.reduce<number>(
              (sum, value) => sum + Math.max(0, value ?? 0),
              0,
            ),
            row.reduce<number>(
              (sum, value) => sum + Math.min(0, value ?? 0),
              0,
            ),
          ]
        : row.filter((value): value is number => value !== null),
    );
    const all = totals.flat();
    const low = Math.min(0, ...all);
    const high = Math.max(0, ...all);
    const ticks = rangeTicks(low, high === low ? low + 1 : high);
    return { ticks, low: ticks[0], high: ticks[ticks.length - 1] };
  }, [node.data, node.series, stacked]);

  const plotW = Math.max(0, width - GUTTER.left - GUTTER.right);
  const plotH = HEIGHT - GUTTER.top - GUTTER.bottom;
  const count = labels.length;
  const band = count ? plotW / count : 0;
  const y = (value: number) =>
    GUTTER.top +
    plotH -
    ((value - domain.low) / (domain.high - domain.low || 1)) * plotH;
  const x = (index: number) =>
    bars
      ? GUTTER.left + band * index + band / 2
      : GUTTER.left + (count > 1 ? (plotW * index) / (count - 1) : plotW / 2);
  const groupW = Math.min(
    band * 0.7,
    bars && !stacked ? 24 * series.length + 2 * (series.length - 1) : 24,
  );
  const barW = stacked
    ? Math.max(2, Math.min(24, band * 0.62))
    : Math.max(2, (groupW - 2 * (series.length - 1)) / series.length);
  // Labels along the bottom thin out so they never collide.
  const every = Math.max(1, Math.ceil((count * 64) / Math.max(1, plotW)));

  function onKeyDown(event: KeyboardEvent) {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Escape") setActive(null);
    if (!step) return;
    event.preventDefault();
    setActive((index) =>
      Math.min(count - 1, Math.max(0, index === null ? 0 : index + step)),
    );
  }

  const current =
    active === null ? null : { label: labels[active], values: values[active] };
  return (
    <div className="flex flex-col gap-2">
      <div
        ref={box}
        role="figure"
        aria-label={node.title ?? `${node.kind} chart`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className="in-chart relative outline-none focus-visible:rounded-[8px] focus-visible:shadow-(--focus-ring)"
        style={{ height: HEIGHT }}
      >
        {width > 0 ? (
          <svg
            width={width}
            height={HEIGHT}
            aria-hidden
            className="block overflow-visible"
          >
            {domain.ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={GUTTER.left}
                  x2={GUTTER.left + plotW}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="currentColor"
                  strokeOpacity={tick === 0 ? 0.22 : 0.08}
                />
                <text
                  x={GUTTER.left - 8}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                  fill="currentColor"
                >
                  {axisLabel(tick, node.format)}
                </text>
              </g>
            ))}
            {bars
              ? values.map((row, index) => {
                  let up = 0;
                  let down = 0;
                  const dim = active !== null && active !== index;
                  return (
                    <g
                      key={index}
                      opacity={dim ? 0.4 : 1}
                      style={{ transition: "opacity 120ms" }}
                    >
                      <rect
                        x={x(index) - band / 2}
                        y={GUTTER.top}
                        width={band}
                        height={plotH}
                        fill="transparent"
                        onPointerEnter={() => setActive(index)}
                      />
                      {row.map((value, at) => {
                        if (value === null || value === 0) return null;
                        if (stacked) {
                          const base = value > 0 ? up : down;
                          const next = base + value;
                          if (value > 0) up = next;
                          else down = next;
                          const last =
                            value > 0
                              ? row
                                  .slice(at + 1)
                                  .every((later) => (later ?? 0) <= 0)
                              : row
                                  .slice(at + 1)
                                  .every((later) => (later ?? 0) >= 0);
                          // A 2px gap in the surface colour between stacked parts.
                          const gap = last ? 0 : value > 0 ? 2 : -2;
                          return (
                            <path
                              key={at}
                              d={barPath(
                                x(index) - barW / 2,
                                barW,
                                y(base),
                                y(next) + gap,
                                last,
                              )}
                              fill={SERIES[at]}
                              pointerEvents="none"
                            />
                          );
                        }
                        const left = x(index) - groupW / 2 + at * (barW + 2);
                        return (
                          <path
                            key={at}
                            d={barPath(left, barW, y(0), y(value), true)}
                            fill={SERIES[at]}
                            pointerEvents="none"
                          />
                        );
                      })}
                    </g>
                  );
                })
              : series.map((item, at) => {
                  const points = values.map((row, index) =>
                    row[at] === null
                      ? null
                      : ([x(index), y(row[at] as number)] as const),
                  );
                  const segments: string[] = [];
                  let run = "";
                  for (const point of points) {
                    if (!point) {
                      if (run) segments.push(run);
                      run = "";
                    } else run += `${run ? "L" : "M"}${point[0]},${point[1]}`;
                  }
                  if (run) segments.push(run);
                  const lastIndex = points.findLastIndex(
                    (point) => point !== null,
                  );
                  return (
                    <g key={item.key} pointerEvents="none">
                      {node.kind === "area"
                        ? segments.map((segment, index) => {
                            const xs = [
                              ...segment.matchAll(/[ML]([\d.]+),/g),
                            ].map((match) => Number(match[1]));
                            return (
                              <path
                                key={index}
                                d={`${segment}L${xs[xs.length - 1]},${y(Math.max(domain.low, 0))}L${xs[0]},${y(Math.max(domain.low, 0))}Z`}
                                fill={SERIES[at]}
                                fillOpacity={0.1}
                              />
                            );
                          })
                        : null}
                      {segments.map((segment, index) => (
                        <path
                          key={index}
                          d={segment}
                          fill="none"
                          stroke={SERIES[at]}
                          strokeWidth={2}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      ))}
                      {lastIndex >= 0 && points[lastIndex] ? (
                        <circle
                          cx={points[lastIndex][0]}
                          cy={points[lastIndex][1]}
                          r={4}
                          fill={SERIES[at]}
                          stroke="var(--card-bg)"
                          strokeWidth={2}
                        />
                      ) : null}
                      {active !== null && points[active] ? (
                        <circle
                          cx={points[active][0]}
                          cy={points[active][1]}
                          r={4}
                          fill={SERIES[at]}
                          stroke="var(--card-bg)"
                          strokeWidth={2}
                        />
                      ) : null}
                    </g>
                  );
                })}
            {!bars
              ? labels.map((_, index) => (
                  <rect
                    key={index}
                    x={
                      x(index) -
                      Math.max(band, plotW / Math.max(1, count - 1)) / 2
                    }
                    y={GUTTER.top}
                    width={Math.max(band, plotW / Math.max(1, count - 1))}
                    height={plotH}
                    fill="transparent"
                    onPointerEnter={() => setActive(index)}
                  />
                ))
              : null}
            {!bars && active !== null ? (
              <line
                x1={x(active)}
                x2={x(active)}
                y1={GUTTER.top}
                y2={GUTTER.top + plotH}
                stroke="currentColor"
                strokeOpacity={0.25}
                pointerEvents="none"
              />
            ) : null}
            {labels.map((label, index) =>
              (index % every === 0 && count - 1 - index >= every) ||
              index === count - 1 ? (
                <text
                  key={`${label}-${index}`}
                  x={x(index)}
                  y={HEIGHT - 6}
                  textAnchor={
                    !bars && index === 0
                      ? "start"
                      : !bars && index === count - 1
                        ? "end"
                        : "middle"
                  }
                  fill={
                    active === index ? "var(--text-secondary)" : "currentColor"
                  }
                >
                  {label.length > 12 ? `${label.slice(0, 11)}…` : label}
                </text>
              ) : null,
            )}
          </svg>
        ) : null}
        <div aria-live="polite" className="sr-only">
          {current
            ? `${current.label}: ${series.map((item, at) => `${item.label ?? item.key} ${formatValue(current.values[at], node.format || "number")}`).join(", ")}`
            : ""}
        </div>
        {current && active !== null ? (
          <div
            className="in-pop pointer-events-none absolute z-10 flex min-w-[130px] flex-col gap-1 px-2.5 py-2 text-[11px]"
            style={{
              left: Math.min(Math.max(x(active), 80), width - 80),
              top: GUTTER.top,
              transform: "translate(-50%, -100%)",
            }}
          >
            <span className="text-(--text-tertiary)">{current.label}</span>
            {series.map((item, at) => (
              <span key={item.key} className="flex items-center gap-1.5">
                <span
                  className="size-1.5 shrink-0 rounded-[2px]"
                  style={{ background: SERIES[at] }}
                />
                <span className="min-w-0 flex-1 truncate text-(--text-secondary)">
                  {item.label ?? item.key}
                </span>
                <span className="in-num text-(--text-primary)">
                  {current.values[at] === null
                    ? "–"
                    : formatValue(current.values[at], node.format || "number")}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {series.length > 1 ? (
        <Legend
          items={series.map((item, at) => ({
            label: item.label ?? item.key,
            color: SERIES[at],
          }))}
        />
      ) : null}
    </div>
  );
}

function DonutChart({ node }: { node: ChartNode }) {
  const [active, setActive] = useState<number | null>(null);
  const key = node.series[0].key;
  const slices = useMemo(() => {
    const all = node.data
      .map((row) => ({
        label: String(row[node.x] ?? ""),
        value: Math.max(0, num(row[key]) ?? 0),
      }))
      .filter((slice) => slice.value > 0)
      .sort((a, b) => b.value - a.value);
    const kept =
      all.length > SERIES.length ? all.slice(0, SERIES.length - 1) : all;
    const rest = all
      .slice(kept.length)
      .reduce((sum, slice) => sum + slice.value, 0);
    return [
      ...kept.map((slice, index) => ({ ...slice, color: SERIES[index] })),
      ...(rest > 0 ? [{ label: "Other", value: rest, color: OTHER }] : []),
    ];
  }, [node.data, node.x, key]);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const size = 148;
  const radius = 60;
  const thickness = 16;
  let angle = -Math.PI / 2;
  const arcs = slices.map((slice) => {
    const sweep = (slice.value / total) * Math.PI * 2;
    const start = angle;
    angle += sweep;
    // A small gap between slices, in the surface colour.
    const pad = slices.length > 1 ? Math.min(0.03, sweep / 4) : 0;
    const a = start + pad;
    const b = angle - pad;
    const point = (t: number, r: number) => [
      size / 2 + r * Math.cos(t),
      size / 2 + r * Math.sin(t),
    ];
    const large = b - a > Math.PI ? 1 : 0;
    const [x1, y1] = point(a, radius);
    const [x2, y2] = point(b, radius);
    const d =
      slices.length === 1
        ? `M${size / 2},${size / 2 - radius}a${radius},${radius} 0 1,1 -0.01,0`
        : `M${x1},${y1}A${radius},${radius} 0 ${large},1 ${x2},${y2}`;
    return { ...slice, d };
  });
  const shown = active === null ? null : slices[active];
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div
        role="figure"
        aria-label={node.title ?? "Donut chart"}
        className="relative shrink-0"
        style={{ width: size, height: size }}
        onPointerLeave={() => setActive(null)}
      >
        <svg width={size} height={size} aria-hidden>
          {arcs.map((arc, index) => (
            <path
              key={arc.label}
              d={arc.d}
              fill="none"
              stroke={arc.color}
              strokeWidth={thickness}
              opacity={active !== null && active !== index ? 0.4 : 1}
              onPointerEnter={() => setActive(index)}
              style={{ transition: "opacity 120ms" }}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="in-num text-[15px] text-(--text-primary)">
            {formatValue(shown ? shown.value : total, node.format || "number")}
          </span>
          <span className="max-w-[90px] truncate text-[11px] text-(--text-tertiary)">
            {shown ? shown.label : "Total"}
          </span>
        </div>
      </div>
      <div className="flex min-w-[160px] flex-1 flex-col gap-1">
        {slices.map((slice, index) => (
          <div
            key={slice.label}
            onPointerEnter={() => setActive(index)}
            onPointerLeave={() => setActive(null)}
            className={cn(
              "flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[12px]",
              active === index && "bg-(--bg-hover)",
            )}
          >
            <span
              className="size-2 shrink-0 rounded-[2px]"
              style={{ background: slice.color }}
            />
            <span className="min-w-0 flex-1 truncate text-(--text-secondary)">
              {slice.label}
            </span>
            <span className="in-num text-(--text-primary)">
              {formatValue(slice.value, node.format || "number")}
            </span>
            <span className="in-num w-10 text-right text-(--text-tertiary)">
              {Math.round((slice.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function UiChart({ node }: { node: ChartNode }) {
  return node.kind === "donut" ? (
    <DonutChart node={node} />
  ) : (
    <CartesianChart node={node} />
  );
}
