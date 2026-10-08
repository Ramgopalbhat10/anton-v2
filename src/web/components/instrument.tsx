import type { LucideIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { Icon } from '@/components/signal';
import { cn } from '@/lib/utils';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const TEXT: Record<Tone, string> = {
	neutral: 'text-(--text-tertiary)',
	accent: 'text-(--accent-text)',
	success: 'text-(--success-text)',
	warning: 'text-(--warning-text)',
	danger: 'text-(--danger-text)',
};

const FILL: Record<Tone, string> = {
	neutral: 'var(--text-tertiary)',
	accent: 'var(--accent-base)',
	success: 'var(--success-base)',
	warning: 'var(--warning-base)',
	danger: 'var(--danger-base)',
};

export const toneFill = (tone: Tone) => FILL[tone];

/** A tone for how much of a cap is used: calm, then amber from 80 percent, red when reached. */
export const usedTone = (fraction: number): Tone => (fraction >= 1 ? 'danger' : fraction >= 0.8 ? 'warning' : 'accent');

/** The mono, uppercase caption under gauges and in card footers. */
export function Caption({ children, className, tone }: { children: ReactNode; className?: string; tone?: Tone }) {
	return <span className={cn('in-caption', tone && TEXT[tone], className)}>{children}</span>;
}

/** A small status word in a card header or row: "LIVE", "2 FAILING", "CAP 80%". */
export function Status({ tone = 'neutral', pulse, children }: { tone?: Tone; pulse?: boolean; children: ReactNode }) {
	return (
		<span className={cn('in-caption inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap', TEXT[tone])}>
			{tone !== 'neutral' ? <span className={cn('size-1.5 rounded-full', pulse && 'in-pulse')} style={{ background: FILL[tone] }} /> : null}
			{children}
		</span>
	);
}

/** The square, dashed tile a card's icon sits in. */
export function IconTile({ icon, tone = 'neutral', size = 26 }: { icon: LucideIcon; tone?: Tone; size?: number }) {
	return (
		<span
			className={cn('inline-flex shrink-0 items-center justify-center rounded-[8px] border border-dashed border-(--border-strong)', tone === 'neutral' ? 'text-(--icon-secondary)' : TEXT[tone])}
			style={{ width: size, height: size }}
		>
			<Icon icon={icon} size={13} />
		</span>
	);
}

/**
 * A titled card: icon, title / what it covers, a status on the right, then its
 * body, and a footer with a caption and the actions that change it.
 */
export function Card({
	icon,
	title,
	sub,
	status,
	children,
	footer,
	className,
	as: As = 'section',
	label,
}: {
	icon?: LucideIcon;
	title?: ReactNode;
	sub?: ReactNode;
	status?: ReactNode;
	children?: ReactNode;
	footer?: ReactNode;
	className?: string;
	as?: 'section' | 'div';
	/** Names the card for assistive tech when its title is not plain text. */
	label?: string;
}) {
	return (
		<As className={cn('in-card', className)} aria-label={label}>
			{title ? (
				<header className="flex min-h-12 items-center gap-2.5 px-4 pt-3 pb-2">
					{icon ? <IconTile icon={icon} /> : null}
					<div className="flex min-w-0 flex-1 items-baseline gap-1.5">
						<h2 className="m-0 truncate text-[13px] leading-[18px] font-medium tracking-[-0.005em] text-(--text-primary)">{title}</h2>
						{sub ? (
							<>
								<span className="text-[12px] text-(--text-disabled)">/</span>
								<span className="min-w-0 truncate text-[12px] text-(--text-tertiary)">{sub}</span>
							</>
						) : null}
					</div>
					{status}
				</header>
			) : null}
			{children}
			{footer}
		</As>
	);
}

/** A padded stretch of a card, ruled off from the one above it. */
export function CardSection({ label, hint, children, className, ruled = true }: { label?: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string; ruled?: boolean }) {
	return (
		<div className={cn('flex flex-col gap-3 px-4 py-3.5', ruled && 'border-t border-(--border-subtle)', className)}>
			{label || hint ? (
				<div className="flex items-center gap-3">
					{label ? <Caption className="min-w-0 flex-1 truncate">{label}</Caption> : <span className="flex-1" />}
					{hint ? <Caption className="shrink-0">{hint}</Caption> : null}
				</div>
			) : null}
			{children}
		</div>
	);
}

/** The bar along a card's bottom: a caption on the left, its actions on the right. */
export function CardFooter({ caption, children }: { caption?: ReactNode; children?: ReactNode }) {
	return (
		<footer className="mt-auto flex min-h-[52px] flex-wrap items-center gap-2 border-t border-(--border-subtle) px-4 py-2.5">
			<div className="min-w-0 flex-1">{typeof caption === 'string' ? <Caption>{caption}</Caption> : caption}</div>
			{children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
		</footer>
	);
}

/** The darker inset a chart or illustration sits in. */
export function Well({ children, className, grid }: { children: ReactNode; className?: string; grid?: boolean }) {
	return <div className={cn('in-well overflow-hidden', grid && 'in-grid', className)}>{children}</div>;
}

/**
 * A hero number: the value large, its fraction dimmed, a unit and a note in
 * mono beside it. "$160.42" reads as "$160" and ".42".
 */
export function Figure({
	value,
	unit,
	note,
	size = 'lg',
	tone,
	className,
}: {
	value: string;
	unit?: ReactNode;
	note?: ReactNode;
	size?: 'md' | 'lg' | 'xl';
	tone?: Tone;
	className?: string;
}) {
	const match = value.match(/^([^.]*\d)(\.\d+)(.*)$/);
	const [whole, fraction, rest] = match ? [match[1], match[2], match[3]] : [value, '', ''];
	return (
		<div className={cn('flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5', className)}>
			<span
				className={cn('in-figure whitespace-nowrap', size === 'xl' ? 'text-[34px] leading-[38px]' : size === 'lg' ? 'text-[26px] leading-[32px]' : 'text-[18px] leading-[24px]', tone && TEXT[tone])}
				aria-label={value}
			>
				<span aria-hidden>{whole}</span>
				{fraction ? (
					<span aria-hidden className="text-(--text-disabled)">
						{fraction}
					</span>
				) : null}
				{rest ? <span aria-hidden>{rest}</span> : null}
			</span>
			{unit ? <span className="in-num text-[12px] whitespace-nowrap text-(--text-tertiary)">{unit}</span> : null}
			{note}
		</div>
	);
}

/** A change beside a figure: "+12%", "−$0.40", "3 failing". */
export function Delta({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
	const bg: Record<Tone, string> = {
		neutral: 'bg-(--alpha-white-6)',
		accent: 'bg-(--accent-bg-subtle)',
		success: 'bg-(--success-bg)',
		warning: 'bg-(--warning-bg)',
		danger: 'bg-(--danger-bg)',
	};
	return <span className={cn('in-num inline-flex h-5 items-center rounded-md px-1.5 text-[11px] whitespace-nowrap', bg[tone], TEXT[tone])}>{children}</span>;
}

/** Stats side by side, ruled apart: a value over a caption. */
export function StatRow({ stats, className }: { stats: Array<{ label: ReactNode; value: ReactNode; tone?: Tone; title?: string }>; className?: string }) {
	return (
		<div className={cn('grid border-t border-(--border-subtle)', className)} style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
			{stats.map((stat, index) => (
				<div key={index} title={stat.title} className={cn('flex min-w-0 flex-col gap-0.5 px-4 py-3', index > 0 && 'border-l border-(--border-subtle)')}>
					<span className={cn('in-figure truncate text-[15px] leading-[20px]', stat.tone && TEXT[stat.tone])}>{stat.value}</span>
					<span className="truncate text-[11px] leading-4 text-(--text-tertiary)">{stat.label}</span>
				</div>
			))}
		</div>
	);
}

export type Marker = { at: number; label: string; tone?: Tone };

/**
 * A ruler of ticks from 0 to `max`, lit up to `value`, with labelled markers
 * standing taller at the points that matter: spent, cap, auto-pause.
 */
export function TickGauge({
	value,
	max,
	markers = [],
	ticks = 56,
	tone = 'accent',
	label,
	scale,
}: {
	value: number;
	max: number;
	markers?: Marker[];
	ticks?: number;
	tone?: Tone;
	label: string;
	/** Labels under the ruler, start to end. */
	scale?: string[];
}) {
	const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
	const lit = Math.round(fraction * ticks);
	const markerAt = (at: number) => Math.min(ticks, Math.max(0, Math.round((max > 0 ? at / max : 0) * ticks)));
	return (
		<div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="flex flex-col gap-1.5">
			<div className="relative h-4">
				{markers.map((marker) => (
					<span
						key={marker.label}
						className={cn('in-caption absolute bottom-0 -translate-x-1/2 whitespace-nowrap normal-case tracking-normal', TEXT[marker.tone ?? 'neutral'])}
						style={{ left: `${(markerAt(marker.at) / ticks) * 100}%` }}
					>
						{marker.label}
					</span>
				))}
			</div>
			<div className="flex h-[18px] items-end justify-between">
				{Array.from({ length: ticks + 1 }, (_, index) => {
					const marker = markers.find((entry) => markerAt(entry.at) === index);
					const major = index % 8 === 0;
					return (
						<span
							key={index}
							className="w-px rounded-full"
							style={{
								height: marker ? 18 : major ? 12 : 8,
								background: marker ? FILL[marker.tone ?? 'neutral'] : index <= lit && lit > 0 ? FILL[tone] : 'var(--tick-off)',
								opacity: marker || index <= lit ? 1 : major ? 0.9 : 0.7,
							}}
						/>
					);
				})}
			</div>
			{scale ? (
				<div className="flex justify-between">
					{scale.map((entry, index) => (
						<Caption key={index} className="tracking-normal normal-case">
							{entry}
						</Caption>
					))}
				</div>
			) : null}
		</div>
	);
}

/** A meter in blocks: so many of `segments` lit, the last few amber past a warning point. */
export function SegmentMeter({
	value,
	segments = 32,
	tone = 'accent',
	label,
	live,
	height = 10,
}: {
	value: number;
	segments?: number;
	tone?: Tone;
	label: string;
	live?: boolean;
	height?: number;
}) {
	const fraction = Math.min(1, Math.max(0, value));
	const lit = fraction > 0 ? Math.max(1, Math.round(fraction * segments)) : 0;
	return (
		<div
			role="meter"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(fraction * 100)}
			className={cn('flex gap-[3px]', live && lit > 0 && 'in-sweep rounded-[2px]')}
			style={{ height }}
		>
			{Array.from({ length: segments }, (_, index) => (
				<span key={index} className="min-w-0 flex-1 rounded-[2px]" style={{ background: index < lit ? FILL[tone] : 'var(--segment-off)' }} />
			))}
		</div>
	);
}

export type Part = { key: string; label: string; value: number; color: string };

/** One bar split by share, with its legend under it. */
export function SplitBar({ parts, label, legend = true, format }: { parts: Part[]; label: string; legend?: boolean; format?: (part: Part, share: number) => string }) {
	const total = parts.reduce((sum, part) => sum + part.value, 0);
	const shown = parts.filter((part) => part.value > 0);
	return (
		<div className="flex flex-col gap-2.5">
			<div role="img" aria-label={label} className="flex h-2.5 gap-[3px]">
				{total > 0 ? (
					shown.map((part) => <span key={part.key} className="min-w-[3px] rounded-[2px]" style={{ flexGrow: part.value, flexBasis: 0, background: part.color }} title={part.label} />)
				) : (
					<span className="flex-1 rounded-[2px] bg-(--segment-off)" />
				)}
			</div>
			{legend ? (
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					{parts.map((part) => (
						<span key={part.key} className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-(--text-tertiary)">
							<span className="size-2 shrink-0 rounded-[2px]" style={{ background: part.color }} />
							<span className="truncate">{part.label}</span>
							<span className="in-num text-(--text-secondary)">{format ? format(part, total ? part.value / total : 0) : part.value}</span>
						</span>
					))}
				</div>
			) : null}
		</div>
	);
}

/** A ranked row: what it is, a bar for its share of the largest, and its value. */
export function ShareRow({ label, sub, share, value, color = 'var(--accent-base)' }: { label: ReactNode; sub?: ReactNode; share: number; value: ReactNode; color?: string }) {
	return (
		<div className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 py-1.5 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto]">
			<div className="flex min-w-0 flex-col">
				<span className="truncate text-[12px] text-(--text-primary)">{label}</span>
				{sub ? <span className="in-num truncate text-[11px] text-(--text-disabled)">{sub}</span> : null}
			</div>
			<div className="order-last col-span-2 h-1.5 overflow-hidden rounded-full bg-(--segment-off) sm:order-none sm:col-span-1">
				<div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, share * 100))}%`, background: color }} />
			</div>
			<span className="in-num text-right text-[12px] whitespace-nowrap text-(--text-secondary)">{value}</span>
		</div>
	);
}

/** Small dots, one per item, coloured by state: the pips beside a pull request's checks. */
export function Pips({ items, label }: { items: Array<{ tone: Tone; title?: string }>; label: string }) {
	return (
		<span role="img" aria-label={label} className="inline-flex items-center gap-[3px]">
			{items.map((item, index) => (
				<span key={index} title={item.title} className="size-1.5 rounded-full" style={{ background: FILL[item.tone] }} />
			))}
		</span>
	);
}

/** "A · B · C" in mono caption type. */
export function Facts({ items, className }: { items: ReactNode[]; className?: string }) {
	return (
		<span className={cn('in-caption flex min-w-0 items-center gap-1.5 truncate', className)}>
			{items.filter(Boolean).map((item, index) => (
				<Fragment key={index}>
					{index > 0 ? <span className="opacity-60">·</span> : null}
					<span className="truncate">{item}</span>
				</Fragment>
			))}
		</span>
	);
}

/** A small mono count in a pill: beside a tab, a section heading or a nav item. */
export function Count({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent'; className?: string }) {
	return (
		<span
			className={cn(
				'in-num inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 text-[10.5px]',
				tone === 'accent' ? 'bg-(--accent-bg-subtle) text-(--accent-text)' : 'bg-(--alpha-white-6) text-(--text-tertiary)',
				className,
			)}
		>
			{children}
		</span>
	);
}

/** The well a segmented control sits in; its items are `SegmentedItem`s. */
export function Segmented({ children, label, className, role = 'tablist' }: { children: ReactNode; label: string; className?: string; role?: 'tablist' | 'radiogroup' | 'group' }) {
	return (
		<div role={role} aria-label={label} className={cn('inline-flex min-w-0 items-center gap-0.5 rounded-[10px] border border-(--border-subtle) bg-(--well-bg) p-[3px]', className)}>
			{children}
		</div>
	);
}

/** One option of a segmented control: raised on the well when it is the chosen one. */
export function SegmentedItem({
	on,
	onClick,
	children,
	role = 'tab',
	size = 'md',
	className,
	title,
}: {
	on: boolean;
	onClick: () => void;
	children: ReactNode;
	role?: 'tab' | 'radio' | 'button';
	size?: 'sm' | 'md';
	className?: string;
	title?: string;
}) {
	const state = role === 'tab' ? { 'aria-selected': on } : role === 'radio' ? { 'aria-checked': on } : { 'aria-pressed': on };
	return (
		<button
			type="button"
			role={role === 'button' ? undefined : role}
			{...state}
			title={title}
			onClick={onClick}
			className={cn(
				'inline-flex min-w-0 items-center justify-center gap-1.5 rounded-[7px] border whitespace-nowrap outline-none transition-colors duration-(--duration-micro) focus-visible:shadow-(--focus-ring)',
				size === 'sm' ? 'h-[22px] px-2 text-[11px]' : 'h-7 px-3 text-[12.5px]',
				on
					? 'border-(--card-border) bg-[linear-gradient(180deg,var(--neutral-750),var(--neutral-800))] text-(--text-primary) shadow-(--card-highlight)'
					: 'border-transparent text-(--text-tertiary) hover:text-(--text-secondary)',
				className,
			)}
		>
			{children}
		</button>
	);
}

/**
 * A diff's size as five blocks, the way a pull request shows it: green for
 * lines added, red for lines removed, grey for the rest of a small change.
 */
export function DiffBars({ added, removed, blocks = 5 }: { added: number; removed: number; blocks?: number }) {
	const total = added + removed;
	// Small changes light fewer blocks, so a one-line edit doesn't read like a rewrite.
	const lit = total === 0 ? 0 : Math.min(blocks, Math.max(1, Math.ceil(Math.log10(total + 1) * 2)));
	const green = total ? Math.round((added / total) * lit) : 0;
	const red = lit - green;
	return (
		<span role="img" aria-label={`${added} added, ${removed} removed`} className="inline-flex shrink-0 items-center gap-[2px]">
			{Array.from({ length: blocks }, (_, index) => (
				<span
					key={index}
					className="size-[7px] rounded-[2px]"
					style={{ background: index < green ? 'var(--success-base)' : index < green + red ? 'var(--danger-base)' : 'var(--segment-off)' }}
				/>
			))}
		</span>
	);
}

/** A path as its file name, bright, after its folder, dimmed. */
export function PathName({ path, className, active }: { path: string; className?: string; active?: boolean }) {
	const slash = path.lastIndexOf('/');
	return (
		<span className={cn('flex min-w-0 items-baseline gap-1.5 text-[12px]', className)} title={path}>
			<span className={cn('shrink-0 truncate', active ? 'text-(--text-primary)' : 'text-(--text-secondary)')}>{path.slice(slash + 1)}</span>
			{slash > 0 ? <span className="min-w-0 truncate text-[11px] text-(--text-disabled)">{path.slice(0, slash)}</span> : null}
		</span>
	);
}
