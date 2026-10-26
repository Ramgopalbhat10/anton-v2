import type { LucideIcon } from 'lucide-react';
import { Check, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { DropdownMenu as MenuPrimitive, Popover } from 'radix-ui';
import { type ComponentProps, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type Size = 'xs' | 'sm' | 'md' | 'lg';
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost';

const ICON_SIZE: Record<Size, number> = { xs: 12, sm: 14, md: 14, lg: 16 };

export function Icon({ icon: Glyph, size = 14, className, style }: { icon: LucideIcon; size?: number; className?: string; style?: CSSProperties }) {
	return <Glyph aria-hidden size={size} strokeWidth={1.5} className={cn('shrink-0', className)} style={style} />;
}

export function Btn({
	variant = 'secondary',
	size = 'md',
	icon,
	block,
	className,
	children,
	type = 'button',
	...rest
}: ComponentProps<'button'> & { variant?: Variant; size?: Size; icon?: LucideIcon; block?: boolean }) {
	return (
		<button
			type={type}
			className={cn('sg-btn', `sg-btn--${variant}`, `sg-btn--${size}`, block && 'sg-btn--block', className)}
			{...rest}
		>
			{icon ? <Icon icon={icon} size={ICON_SIZE[size]} /> : null}
			{children}
		</button>
	);
}

export function IconBtn({
	icon,
	label,
	variant = 'ghost',
	size = 'md',
	className,
	type = 'button',
	...rest
}: ComponentProps<'button'> & { icon: LucideIcon; label: string; variant?: Variant; size?: Size }) {
	return (
		<button
			type={type}
			aria-label={label}
			title={label}
			className={cn('sg-btn sg-icon-btn', `sg-btn--${variant}`, `sg-btn--${size}`, className)}
			{...rest}
		>
			<Icon icon={icon} size={ICON_SIZE[size]} />
		</button>
	);
}

/** How long the cube rests between turns, at random within this span. */
const TURN_GAP_MS = [1800, 4500] as const;

/** A turn now and then, at random: a spin a third round, or a hop and a roll two thirds over; none with reduced motion. */
function useTurns(): ['spin' | 'roll' | null, () => void] {
	const [turn, setTurn] = useState<'spin' | 'roll' | null>(null);
	useEffect(() => {
		if (turn || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
		const timer = setTimeout(() => setTurn(Math.random() < 0.55 ? 'spin' : 'roll'), TURN_GAP_MS[0] + Math.random() * (TURN_GAP_MS[1] - TURN_GAP_MS[0]));
		return () => clearTimeout(timer);
	}, [turn]);
	return [turn, () => setTurn(null)];
}

/**
 * Waiting, drawn as Anton's cube: its faces lift out and brighten in turn,
 * and now and then it spins or rolls over (`.sg-spinner` in instrument.css);
 * from 16px it has the mascot's eyes.
 */
export function Spinner({ size = 14, tone = 'accent' }: { size?: number; tone?: 'accent' | 'neutral' | 'onAccent' }) {
	const [turn, rest] = useTurns();
	return (
		<span role="status" aria-label="Loading" className={cn('sg-spinner', tone !== 'accent' && `sg-spinner--${tone}`, turn && `is-${turn}`)} style={{ width: size, height: size }}>
			<svg aria-hidden width={size} height={size} viewBox="3.5 5.2 17 17.8" className="overflow-visible">
				<g
					className="sl-cube"
					onAnimationEnd={(event) => {
						if (event.target === event.currentTarget) rest();
					}}
				>
					<polygon className="sl-face sl-top" points="12,6 19.1,10.1 12,14.2 4.9,10.1" />
					<polygon className="sl-face sl-left" points="4.9,10.1 12,14.2 12,22.4 4.9,18.3" />
					<polygon className="sl-face sl-right" points="12,14.2 19.1,10.1 19.1,18.3 12,22.4" />
					{size >= 16 ? (
						<g className="sl-face sl-left">
							<g className="sl-eyes" stroke="#06181F" strokeWidth="1.75" strokeLinecap="round">
								<path d="M7.03 14.28v2.13" />
								<path d="M9.87 15.92v2.13" />
							</g>
						</g>
					) : null}
				</g>
			</svg>
		</span>
	);
}

const GLYPHS: Record<string, string> = { mod: '⌘', enter: '↵', shift: '⇧', esc: 'Esc' };

export function Kbd({ keys, size = 'md' }: { keys: string; size?: 'sm' | 'md' }) {
	return (
		<span className="sg-kbd-group">
			{keys.split('+').map((key, index) => (
				<span key={key + index} className={cn('sg-kbd', size === 'sm' && 'sg-kbd--sm')}>
					{GLYPHS[key.toLowerCase()] ?? key.toUpperCase()}
				</span>
			))}
		</span>
	);
}

export function InlineCode({ children }: { children: ReactNode }) {
	// Long commands and paths wrap rather than run out of a phone-width card.
	return <code className="sg-code wrap-break-word whitespace-normal [box-decoration-break:clone]">{children}</code>;
}

function initials(name: string) {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase();
}

export function Avatar({ name, size = 'sm' }: { name: string; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
	return (
		<span className={cn('sg-avatar', `sg-avatar--${size}`)} title={name}>
			{initials(name)}
		</span>
	);
}

/** Uppercase group label: "RUNNING", "RECENT", "ADD A PANEL". */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={cn('font-mono text-[10.5px] leading-4 font-medium tracking-[0.08em] uppercase text-(--text-disabled)', className)}>
			{children}
		</div>
	);
}

/**
 * The rest of what a setting means, behind an info icon beside its label:
 * a popover that opens while the pointer rests on the icon, and on a tap
 * where there is no pointer to rest.
 */
export function InfoTip({ children, label = 'More about this' }: { children: ReactNode; label?: string }) {
	const [open, setOpen] = useState(false);
	const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
	const stay = () => clearTimeout(leaving.current);
	const leave = () => {
		stay();
		leaving.current = setTimeout(() => setOpen(false), 120);
	};
	const hover = {
		onPointerEnter: (event: ReactPointerEvent) => {
			if (event.pointerType !== 'mouse') return;
			stay();
			setOpen(true);
		},
		onPointerLeave: (event: ReactPointerEvent) => {
			if (event.pointerType === 'mouse') leave();
		},
	};
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label={label}
					{...hover}
					// A mouse opened it by resting there, so a click keeps it open rather than toggling it shut.
					onClick={(event) => {
						if (!open || (event.nativeEvent as PointerEvent).pointerType !== 'mouse') return;
						event.preventDefault();
					}}
					className="inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full align-[-2px] text-(--icon-tertiary) outline-none hover:text-(--icon-secondary) focus-visible:shadow-(--focus-ring) data-[state=open]:text-(--icon-secondary)"
				>
					<Icon icon={Info} size={13} />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					side="top"
					align="start"
					sideOffset={6}
					collisionPadding={12}
					{...hover}
					onOpenAutoFocus={(event) => event.preventDefault()}
					onClick={(event) => event.stopPropagation()}
					className="in-pop z-50 w-[min(300px,calc(100vw-24px))] px-3 py-2.5 text-[12px] leading-[18px] font-normal tracking-normal text-pretty normal-case text-(--text-secondary) outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
				>
					{children}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** Small meta text: timestamps, repo/branch facts, counts. */
export function Meta({ children, className }: { children: ReactNode; className?: string }) {
	return <span className={cn('text-[11px] tracking-[0.04em] text-(--text-disabled)', className)}>{children}</span>;
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="text-[11px]">
			<span className="text-(--success-text)">+{added}</span>{' '}
			<span className={removed ? 'text-(--danger-text)' : 'text-(--text-disabled)'}>-{removed}</span>
		</span>
	);
}

/** Empty state: icon tile, title, body, optional actions. */
export function EmptyState({
	icon,
	art,
	title,
	body,
	children,
	className,
}: {
	icon?: LucideIcon;
	/** A drawing shown in place of the icon; the drafting grid then spans the width and holds the words too. */
	art?: ReactNode;
	title: string;
	body?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	if (art) {
		// The drawing gets the whole width: the drafting grid runs edge to edge and
		// the words sit on it, under the drawing.
		return (
			<div className={cn('in-well in-grid flex w-full flex-col items-center gap-5 px-6 pt-10 pb-9 text-center', className)}>
				<div className="flex w-full justify-center">{art}</div>
				<div className="flex flex-col items-center gap-1">
					<div className="text-[14px] leading-[21px] font-medium text-(--text-primary)">{title}</div>
					{body ? <div className="max-w-[48ch] text-[12px] leading-[18px] text-(--text-tertiary)">{body}</div> : null}
				</div>
				{children ? <div className="flex items-center gap-2">{children}</div> : null}
			</div>
		);
	}
	return (
		<div className={cn('flex flex-col items-center gap-3 px-6 py-8 text-center', className)}>
			{icon ? (
				<span className="inline-flex size-8 items-center justify-center rounded-[9px] border border-dashed border-(--border-strong) text-(--icon-secondary)">
					<Icon icon={icon} />
				</span>
			) : null}
			<div className="flex flex-col gap-1">
				<div className="text-[14px] leading-[21px] font-medium text-(--text-primary)">{title}</div>
				{body ? <div className="max-w-[44ch] text-[12px] leading-[18px] text-(--text-tertiary)">{body}</div> : null}
			</div>
			{children ? <div className="flex items-center gap-2">{children}</div> : null}
		</div>
	);
}

/* Menus: Radix behaviour, Signal surface. */
export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;

export function MenuContent({
	className,
	sideOffset = 4,
	...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Content
				sideOffset={sideOffset}
				className={cn(
					'in-pop z-50 flex min-w-[184px] flex-col gap-px p-1.5 text-(--text-primary) outline-none',
					'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
					className,
				)}
				{...props}
			/>
		</MenuPrimitive.Portal>
	);
}

export function MenuItem({
	icon,
	checked,
	hint,
	className,
	children,
	...props
}: ComponentProps<typeof MenuPrimitive.Item> & { icon?: LucideIcon; checked?: boolean; hint?: ReactNode }) {
	return (
		<MenuPrimitive.Item className={cn('sg-menu-item outline-none focus-visible:shadow-none data-highlighted:bg-(--bg-hover)', className)} {...props}>
			{icon ? (
				<span className="sg-menu-item__icon">
					<Icon icon={icon} />
				</span>
			) : null}
			<span className="sg-menu-item__label">{children}</span>
			<span className="sg-menu-item__trail">
				{checked ? <Icon icon={Check} size={13} className="sg-menu-item__check" /> : null}
				{/* Last, so counts line up at the right edge whether or not the item is checked. */}
				{hint !== undefined ? <span className="min-w-4 text-right text-[11px] text-(--text-disabled) tabular-nums">{hint}</span> : null}
			</span>
		</MenuPrimitive.Item>
	);
}

/** A menu item that opens a menu of its own beside it. */
export const MenuSub = MenuPrimitive.Sub;

export function MenuSubTrigger({
	icon,
	hint,
	className,
	children,
	...props
}: ComponentProps<typeof MenuPrimitive.SubTrigger> & { icon?: LucideIcon; hint?: ReactNode }) {
	return (
		<MenuPrimitive.SubTrigger className={cn('sg-menu-item outline-none focus-visible:shadow-none data-highlighted:bg-(--bg-hover) data-[state=open]:bg-(--alpha-white-6)', className)} {...props}>
			{icon ? (
				<span className="sg-menu-item__icon">
					<Icon icon={icon} />
				</span>
			) : null}
			<span className="sg-menu-item__label">{children}</span>
			<span className="sg-menu-item__trail gap-1.5">
				{hint ? <span className="text-[12px] text-(--text-tertiary)">{hint}</span> : null}
				<Icon icon={ChevronRight} size={13} className="text-(--icon-tertiary)" />
			</span>
		</MenuPrimitive.SubTrigger>
	);
}

export function MenuSubContent({ className, ...props }: ComponentProps<typeof MenuPrimitive.SubContent>) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.SubContent
				sideOffset={4}
				collisionPadding={8}
				className={cn(
					'in-pop z-50 flex max-h-(--radix-dropdown-menu-content-available-height) min-w-[184px] flex-col gap-px overflow-y-auto p-1.5 text-(--text-primary) outline-none',
					'data-[state=open]:animate-in data-[state=open]:fade-in-0',
					className,
				)}
				{...props}
			/>
		</MenuPrimitive.Portal>
	);
}

export function MenuLabel({ children }: { children: ReactNode }) {
	return <SectionLabel className="px-2 pt-1.5 pb-1">{children}</SectionLabel>;
}

export function MenuSeparator() {
	return <MenuPrimitive.Separator className="-mx-1.5 my-1 h-px bg-(--border-subtle)" />;
}

/** A pill-shaped picker trigger, as used for the model / repo / branch choosers. */
export function PickerChip({
	icon,
	label,
	height = 26,
	...rest
}: ComponentProps<'button'> & { icon: LucideIcon; label: string; height?: 26 | 28 }) {
	return (
		<button
			type="button"
			className={cn(
				'flex shrink-0 items-center gap-1.5 rounded-lg bg-(--bg-overlay) whitespace-nowrap text-(--text-secondary) transition-colors duration-(--duration-micro) outline-none hover:bg-(--neutral-700) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)',
				height === 28 ? 'h-7 px-2.5' : 'h-[26px] px-2',
			)}
			{...rest}
		>
			<Icon icon={icon} size={12} className="text-(--icon-tertiary)" />
			<span className="text-[12px]">{label}</span>
			<Icon icon={ChevronDown} size={12} className="text-(--icon-tertiary)" />
		</button>
	);
}

/** An on/off switch with its label; the whole row toggles. */
export function Switch({
	checked,
	onChange,
	label,
	disabled,
	className,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: ReactNode;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				'flex items-center gap-2 rounded-md text-[13px] text-(--text-primary) outline-none focus-visible:shadow-(--focus-ring) disabled:opacity-50',
				className,
			)}
		>
			<span
				className={cn(
					'relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors duration-(--duration-micro)',
					checked ? 'bg-(--accent-base)' : 'bg-(--neutral-600)',
				)}
			>
				<span
					className={cn(
						'absolute top-0.5 size-3 rounded-full bg-white transition-transform duration-(--duration-micro)',
						checked ? 'translate-x-3.5' : 'translate-x-0.5',
					)}
				/>
			</span>
			{label}
		</button>
	);
}

const BAR_TONE = { accent: 'bg-(--accent-base)', warning: 'bg-(--warning-base)', danger: 'bg-(--danger-base)' } as const;

/** A thin meter: how much of something is used, from 0 to 100. */
export function ProgressBar({ value, tone = 'accent', label }: { value: number; tone?: keyof typeof BAR_TONE; label: string }) {
	const clamped = Math.min(100, Math.max(0, value));
	return (
		<div role="progressbar" aria-label={label} aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100} className="h-1 w-full overflow-hidden rounded-full bg-(--neutral-750)">
			<div className={cn('h-full rounded-full transition-[width] duration-(--duration-micro)', BAR_TONE[tone])} style={{ width: `${clamped}%` }} />
		</div>
	);
}

const BADGE_TONE = {
	neutral: 'bg-(--bg-raised) text-(--text-secondary)',
	accent: 'bg-(--accent-bg-subtle) text-(--accent-text)',
	success: 'bg-(--success-bg) text-(--success-text)',
	warning: 'bg-(--warning-bg) text-(--warning-text)',
	danger: 'bg-(--danger-bg) text-(--danger-text)',
} as const;

/** A short status word on a row: Connected, Default, Failing. */
export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof BADGE_TONE; children: ReactNode }) {
	return <span className={cn('inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap', BADGE_TONE[tone])}>{children}</span>;
}

/** A filter that toggles on and off, in a row of them. */
export function FilterChip({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			aria-pressed={on}
			onClick={onToggle}
			className={cn(
				'h-[22px] shrink-0 rounded-full px-2 text-[11px] transition-colors duration-(--duration-micro) outline-none focus-visible:shadow-(--focus-ring)',
				on
					? 'bg-(--accent-bg-subtle) text-(--accent-text) shadow-[inset_0_0_0_1px_var(--accent-border)]'
					: 'bg-(--alpha-white-4) text-(--text-tertiary) hover:text-(--text-secondary)',
			)}
		>
			{label}
		</button>
	);
}
