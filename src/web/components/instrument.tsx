import type { LucideIcon } from 'lucide-react';
import { X } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { Icon } from '@/components/signal';
import { cn } from '@/lib/utils';

/** `attention` is what waits on you (the accent); `warning` is something off (amber). */
export type Tone = 'neutral' | 'accent' | 'attention' | 'success' | 'warning' | 'danger';

const TEXT: Record<Tone, string> = {
	neutral: 'text-(--text-tertiary)',
	accent: 'text-(--accent-text)',
	attention: 'text-(--attention-text)',
	success: 'text-(--success-text)',
	warning: 'text-(--warning-text)',
	danger: 'text-(--danger-text)',
};

const FILL: Record<Tone, string> = {
	neutral: 'var(--text-tertiary)',
	accent: 'var(--accent-base)',
	attention: 'var(--attention-base)',
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

/**
 * The one dot that says a state: grey for off or idle, the accent for live,
 * attention for what waits on you, amber for a caution, red for a failure.
 * It pulses only while something is running.
 */
export function StatusDot({ tone = 'neutral', color, pulse, title, className }: { tone?: Tone | 'off'; color?: string; pulse?: boolean; title?: string; className?: string }) {
	return (
		<span
			title={title}
			aria-hidden={title ? undefined : true}
			className={cn('size-1.5 shrink-0 rounded-full', pulse && 'in-pulse', className)}
			style={{ background: color ?? (tone === 'off' ? 'var(--text-disabled)' : FILL[tone]) }}
		/>
	);
}

/** A status as a dot and a word, in a card header or a row: "Live", "2 failing", "Connected". Neutral has no dot. */
export function Status({ tone = 'neutral', color, pulse, children }: { tone?: Tone; /** A colour of its own, over the tone's (a PR state's). */ color?: string; pulse?: boolean; children: ReactNode }) {
	return (
		<span className={cn('in-caption inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap', !color && TEXT[tone])} style={color ? { color } : undefined}>
			{color || tone !== 'neutral' ? <StatusDot tone={tone} color={color} pulse={pulse} /> : null}
			{children}
		</span>
	);
}

/** A card's icon: a bare glyph in the tile's footprint, so titles still line up. */
export function IconTile({ icon, tone = 'neutral', size = 26 }: { icon: LucideIcon; tone?: Tone; size?: number }) {
	return (
		<span
			className={cn('inline-flex shrink-0 items-center justify-center', tone === 'neutral' ? 'text-(--icon-secondary)' : TEXT[tone])}
			style={{ width: size, height: size }}
		>
			<Icon icon={icon} size={16} />
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
						<h2 className="m-0 max-w-full shrink-0 truncate text-body leading-[18px] font-medium tracking-[-0.005em] text-(--text-primary)">{title}</h2>
						{sub ? (
							<>
								<span className="text-small text-(--text-disabled)">/</span>
								<span className="min-w-0 truncate text-small text-(--text-tertiary)">{sub}</span>
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
				className={cn('in-figure whitespace-nowrap', size === 'xl' ? 'text-display leading-[38px]' : size === 'lg' ? 'text-h1 leading-[32px]' : 'text-h2 leading-[24px]', tone && TEXT[tone])}
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
			{unit ? <span className="in-num text-small whitespace-nowrap text-(--text-tertiary)">{unit}</span> : null}
			{note}
		</div>
	);
}

/** A change beside a figure: "+12%", "−$0.40", "3 failing". */
export function Delta({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
	const bg: Record<Tone, string> = {
		neutral: 'bg-(--alpha-white-6)',
		accent: 'bg-(--accent-bg-subtle)',
		attention: 'bg-(--attention-bg)',
		success: 'bg-(--success-bg)',
		warning: 'bg-(--warning-bg)',
		danger: 'bg-(--danger-bg)',
	};
	return <span className={cn('in-num inline-flex h-5 items-center rounded-control px-1.5 text-micro whitespace-nowrap', bg[tone], TEXT[tone])}>{children}</span>;
}

/** Stats side by side, ruled apart: a value over a caption. */
export function StatRow({ stats, className }: { stats: Array<{ label: ReactNode; value: ReactNode; tone?: Tone; color?: string; title?: string }>; className?: string }) {
	return (
		<div className={cn('grid border-t border-(--border-subtle)', className)} style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
			{stats.map((stat, index) => (
				<div key={index} title={stat.title} className={cn('flex min-w-0 flex-col gap-0.5 px-4 py-3', index > 0 && 'border-l border-(--border-subtle)')}>
					<span className={cn('in-figure truncate text-h3 leading-[20px]', !stat.color && stat.tone && TEXT[stat.tone])} style={stat.color ? { color: stat.color } : undefined}>{stat.value}</span>
					<span className="truncate text-micro leading-4 text-(--text-tertiary)">{stat.label}</span>
				</div>
			))}
		</div>
	);
}

/** Labelled values on a grid, like a spec sheet: a mono caption over each value, two across on a phone and three wider. */
export function SpecGrid({ items, className }: { items: Array<{ label: ReactNode; value: ReactNode; tone?: Tone; title?: string }>; className?: string }) {
	return (
		<dl className={cn('m-0 grid grid-cols-2 gap-x-4 gap-y-3.5 border-t border-(--border-subtle) px-4 py-3.5 sm:grid-cols-3', className)}>
			{items.map((item, index) => (
				<div key={index} title={item.title} className="flex min-w-0 flex-col gap-1">
					<dt>
						<Caption>{item.label}</Caption>
					</dt>
					<dd className={cn('in-num m-0 truncate text-body leading-[18px] text-(--text-primary)', item.tone && TEXT[item.tone])}>{item.value}</dd>
				</div>
			))}
		</dl>
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
						className={cn(
							'in-caption absolute bottom-0 whitespace-nowrap normal-case tracking-normal',
							// A label at either end sits inside the gauge rather than hanging past its edge.
							markerAt(marker.at) <= ticks * 0.04 ? '' : markerAt(marker.at) >= ticks * 0.96 ? '-translate-x-full' : '-translate-x-1/2',
							TEXT[marker.tone ?? 'neutral'],
						)}
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
			className={cn('flex gap-[3px]', live && lit > 0 && 'in-sweep rounded-mark')}
			style={{ height }}
		>
			{Array.from({ length: segments }, (_, index) => (
				<span key={index} className="min-w-0 flex-1 rounded-mark" style={{ background: index < lit ? FILL[tone] : 'var(--segment-off)' }} />
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
					shown.map((part) => <span key={part.key} className="min-w-[3px] rounded-mark" style={{ flexGrow: part.value, flexBasis: 0, background: part.color }} title={part.label} />)
				) : (
					<span className="flex-1 rounded-mark bg-(--segment-off)" />
				)}
			</div>
			{legend ? (
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					{parts.map((part) => (
						<span key={part.key} className="inline-flex min-w-0 items-center gap-1.5 text-micro text-(--text-tertiary)">
							<span className="size-2 shrink-0 rounded-mark" style={{ background: part.color }} />
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
				<span className="truncate text-small text-(--text-primary)">{label}</span>
				{sub ? <span className="in-num truncate text-micro text-(--text-disabled)">{sub}</span> : null}
			</div>
			<div className="order-last col-span-2 h-1.5 overflow-hidden rounded-full bg-(--segment-off) sm:order-none sm:col-span-1">
				<div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, share * 100))}%`, background: color }} />
			</div>
			<span className="in-num text-right text-small whitespace-nowrap text-(--text-secondary)">{value}</span>
		</div>
	);
}

/** Small dots, one per item, coloured by state: the pips beside a pull request's checks. */
export function Pips({ items, label }: { items: Array<{ tone?: Tone; color?: string; title?: string }>; label: string }) {
	return (
		<span role="img" aria-label={label} className="inline-flex items-center gap-[3px]">
			{items.map((item, index) => (
				<span key={index} title={item.title} className="size-1.5 rounded-full" style={{ background: item.color ?? FILL[item.tone ?? 'neutral'] }} />
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

const CHIP: Record<Tone, string> = {
	neutral: 'text-(--text-secondary)',
	accent: 'text-(--accent-text) border-(--accent-border)',
	attention: 'text-(--attention-text) border-(--attention-border)',
	success: 'text-(--success-text) border-(--success-border)',
	warning: 'text-(--warning-text) border-(--warning-border)',
	danger: 'text-(--danger-text) border-(--danger-border)',
};

/**
 * A fact on a one-line row, as a small chip: a pull request, a kind, a count,
 * a time. Rows say what a thing is in a few of these; the rest waits on hover.
 */
export function Chip({
	icon,
	iconColor,
	tone = 'neutral',
	color,
	mono,
	title,
	children,
	className,
}: {
	icon?: LucideIcon;
	/** Colours only the icon, for a chip that names a kind without shouting it. */
	iconColor?: string;
	tone?: Tone;
	color?: string;
	mono?: boolean;
	title?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			title={title}
			className={cn(
				'inline-flex h-5 shrink-0 items-center gap-1 rounded-control border border-(--border-subtle) bg-(--alpha-white-4) px-1.5 text-micro leading-none whitespace-nowrap',
				mono && 'in-num text-micro',
				CHIP[tone],
				className,
			)}
			style={color ? { color, borderColor: `color-mix(in oklab, ${color} 32%, transparent)`, background: `color-mix(in oklab, ${color} 10%, transparent)` } : undefined}
		>
			{icon ? <Icon icon={icon} size={11} className="shrink-0" style={iconColor ? { color: iconColor } : undefined} /> : null}
			{children}
		</span>
	);
}

/** A small mono count in a pill: beside a tab, a section heading or a nav item. */
export function Count({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent'; className?: string }) {
	return (
		<span
			className={cn(
				'in-num inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 text-micro',
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
		<div role={role} aria-label={label} className={cn('inline-flex min-w-0 items-center gap-0.5 rounded-control border border-(--border-subtle) bg-(--well-bg) p-[3px]', className)}>
			{children}
		</div>
	);
}

/** One option of a segmented control: filled when it is the chosen one. For two to four ways to show the same thing. */
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
				'inline-flex min-w-0 items-center justify-center gap-1.5 rounded-control border whitespace-nowrap outline-none transition-colors duration-(--duration-micro) focus-visible:shadow-(--focus-ring)',
				size === 'sm' ? 'h-[22px] px-2 text-micro' : 'h-7 px-3 text-body',
				on
					? 'in-chosen border-transparent'
					: 'border-transparent text-(--text-tertiary) hover:text-(--text-secondary)',
				className,
			)}
		>
			{children}
		</button>
	);
}

/** The row the sections of a page sit in, on a rule: a plan, a plugin's parts. Its items are `Tab`s. */
export function Tabs({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
	return (
		<div data-noscrollbar role="tablist" aria-label={label} className={cn('flex gap-5 overflow-x-auto overflow-y-hidden border-b border-(--border-subtle)', className)}>
			{children}
		</div>
	);
}

/** One section of a page: primary text and a rule under it when it is the one shown. */
export function Tab({ on, onSelect, children, id, controls }: { on: boolean; onSelect: () => void; children: ReactNode; id?: string; controls?: string }) {
	return (
		<button
			type="button"
			role="tab"
			id={id}
			aria-controls={controls}
			aria-selected={on}
			onClick={onSelect}
			className={cn(
				'-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-0.5 text-body whitespace-nowrap outline-none transition-colors duration-(--duration-micro) focus-visible:shadow-(--focus-ring)',
				on ? 'border-(--text-primary) text-(--text-primary)' : 'border-transparent text-(--text-tertiary) hover:text-(--text-secondary)',
			)}
		>
			{children}
		</button>
	);
}

/** The row open panels or open files sit in, at the top of a pane. Its items are `PanelTab`s. */
export function PanelTabs({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
	return (
		<div data-noscrollbar role="tablist" aria-label={label} className={cn('flex min-w-0 flex-auto items-center gap-0.5 overflow-x-auto overflow-y-hidden', className)}>
			{children}
		</div>
	);
}

/**
 * One open panel or file, filled when it is the one shown. One that can be
 * closed swaps its mark for the close button while the pointer or focus is on it.
 */
export function PanelTab({
	on,
	onSelect,
	mark,
	children,
	onClose,
	closeLabel,
	id,
	controls,
	title,
}: {
	on: boolean;
	onSelect: () => void;
	/** The icon before the name: a panel's, or a file's own. */
	mark?: ReactNode;
	children: ReactNode;
	onClose?: () => void;
	closeLabel?: string;
	id?: string;
	controls?: string;
	title?: string;
}) {
	return (
		<div className={cn('group/tab relative flex h-7 shrink-0 items-center rounded-control transition-colors duration-(--duration-micro)', on ? 'in-chosen' : 'hover:bg-(--bg-hover)')}>
			<button
				type="button"
				role="tab"
				id={id}
				aria-controls={controls}
				aria-selected={on}
				title={title}
				onClick={onSelect}
				className={cn(
					'flex h-full items-center gap-1.5 rounded-control pr-2 text-small whitespace-nowrap outline-none focus-visible:shadow-(--focus-ring)',
					mark ? 'pl-1.5' : 'pl-2',
					on ? 'text-(--text-primary)' : 'text-(--text-secondary)',
				)}
			>
				{mark ? (
					<span
						className={cn(
							'inline-flex size-4 shrink-0 items-center justify-center',
							on ? 'text-(--icon-primary)' : 'text-(--icon-tertiary)',
							onClose && 'transition-opacity duration-(--duration-micro) group-focus-within/tab:opacity-0 group-hover/tab:opacity-0',
						)}
					>
						{mark}
					</span>
				) : null}
				{children}
			</button>
			{onClose ? (
				<button
					type="button"
					aria-label={closeLabel ?? 'Close'}
					onClick={onClose}
					className="absolute top-1/2 left-1.5 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-inner text-(--text-secondary) opacity-0 transition-opacity duration-(--duration-micro) outline-none group-focus-within/tab:opacity-100 group-hover/tab:opacity-100 hover:bg-(--alpha-white-15) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
				>
					<Icon icon={X} size={12} />
				</button>
			) : null}
		</div>
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
					className="size-[7px] rounded-mark"
					style={{ background: index < green ? 'var(--diff-add-base)' : index < green + red ? 'var(--diff-remove-base)' : 'var(--segment-off)' }}
				/>
			))}
		</span>
	);
}

/** A path as its file name, bright, after its folder, dimmed. */
export function PathName({ path, className, active }: { path: string; className?: string; active?: boolean }) {
	const slash = path.lastIndexOf('/');
	return (
		<span className={cn('flex min-w-0 items-baseline gap-1.5 text-small', className)} title={path}>
			<span className={cn('shrink-0 truncate', active ? 'text-(--text-primary)' : 'text-(--text-secondary)')}>{path.slice(slash + 1)}</span>
			{slash > 0 ? <span className="min-w-0 truncate text-micro text-(--text-disabled)">{path.slice(0, slash)}</span> : null}
		</span>
	);
}
