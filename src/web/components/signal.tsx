import type { LucideIcon } from 'lucide-react';
import { Check, ChevronDown, ChevronRight, Info, Search, X } from 'lucide-react';
import { DropdownMenu as MenuPrimitive, Popover } from 'radix-ui';
import { type ComponentProps, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type Size = 'xs' | 'sm' | 'md' | 'lg';
/** `primary` is the next step (the accent), `inverse` is send, `ghost` a supporting action. */
type Variant = 'primary' | 'inverse' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost';

const ICON_SIZE: Record<Size, number> = { xs: 12, sm: 13, md: 14, lg: 16 };

export function Icon({ icon: Glyph, size = 14, className, style }: { icon: LucideIcon; size?: number; className?: string; style?: CSSProperties }) {
	// Lucide line icons at one stroke, whatever their size.
	return <Glyph aria-hidden size={size} strokeWidth={1.75} className={cn('shrink-0', className)} style={style} />;
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

/** Waiting: a ring with an arc of the accent going round (`.sg-spinner` in instrument.css). */
export function Spinner({ size = 14, tone = 'accent' }: { size?: number; tone?: 'accent' | 'neutral' | 'onAccent' }) {
	return (
		<span role="status" aria-label="Loading" className={cn('sg-spinner', tone !== 'accent' && `sg-spinner--${tone}`)} style={{ width: size, height: size }}>
			<svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none">
				<circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.75" />
				<path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
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
		<div className={cn('text-small leading-4 font-medium text-(--text-3)', className)}>
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
					className="inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full align-[-2px] text-(--text-3) outline-none hover:text-(--text-2) focus-visible:shadow-(--focus) data-[state=open]:text-(--text-2)"
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
					className="in-pop z-50 w-[min(300px,calc(100vw-24px))] px-3 py-2.5 text-small leading-[18px] font-normal tracking-normal text-pretty normal-case text-(--text-2) outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
				>
					{children}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** Small meta text: timestamps, repo/branch facts, counts. */
export function Meta({ children, className }: { children: ReactNode; className?: string }) {
	return <span className={cn('text-small text-(--text-3)', className)}>{children}</span>;
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="in-num text-small">
			<span className="text-(--ok)">+{added}</span>{' '}
			<span className={removed ? 'text-(--bad)' : 'text-(--text-4)'}>−{removed}</span>
		</span>
	);
}

/**
 * Empty state, sized by what holds it and not by the screen: a whole panel
 * or page takes `art` (a drawing on the drafting grid), a card or a tab takes
 * an `icon` or just the words, and a list takes `EmptyLine`.
 */
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
					<div className="text-body-lg leading-[20px] font-semibold tracking-[-0.005em] text-(--text)">{title}</div>
					{body ? <div className="max-w-[48ch] text-body leading-[19px] text-(--text-2)">{body}</div> : null}
				</div>
				{children ? <div className="flex items-center gap-2">{children}</div> : null}
			</div>
		);
	}
	return (
		<div className={cn('flex flex-col items-center gap-3 px-6 py-8 text-center', className)}>
			{icon ? (
				<span className="inline-flex size-10 items-center justify-center rounded-card bg-(--bg-hover) text-(--text-3) shadow-[inset_0_0_0_1px_var(--line)]">
					<Icon icon={icon} size={20} />
				</span>
			) : null}
			<div className="flex flex-col gap-1">
				<div className="text-body-lg leading-[20px] font-semibold tracking-[-0.005em] text-(--text)">{title}</div>
				{body ? <div className="max-w-[44ch] text-body leading-[19px] text-(--text-2)">{body}</div> : null}
			</div>
			{children ? <div className="flex items-center gap-2">{children}</div> : null}
		</div>
	);
}

/** The smallest empty state: one quiet line where a list or a search's results would be. */
export function EmptyLine({ children, className }: { children: ReactNode; className?: string }) {
	return <p className={cn('m-0 px-2 py-1.5 text-small leading-[18px] text-(--text-3)', className)}>{children}</p>;
}

/* Menus: Radix behaviour, Aura surface. */
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
					'in-pop z-50 flex min-w-[200px] flex-col p-1 text-(--text) outline-none',
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
		<MenuPrimitive.Item className={cn('sg-menu-item outline-none', className)} {...props}>
			{icon ? (
				<span className="sg-menu-item__icon">
					<Icon icon={icon} />
				</span>
			) : null}
			<span className="sg-menu-item__label">{children}</span>
			<span className="sg-menu-item__trail">
				{checked ? <Icon icon={Check} size={13} className="sg-menu-item__check" /> : null}
				{/* Last, so counts line up at the right edge whether or not the item is checked. */}
				{hint !== undefined ? <span className="min-w-4 text-right text-small text-(--text-3) tabular-nums">{hint}</span> : null}
			</span>
		</MenuPrimitive.Item>
	);
}

/** Items that belong together, under a MenuLabel, so a screen reader says the group's name. */
export const MenuGroup = MenuPrimitive.Group;

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
		<MenuPrimitive.SubTrigger className={cn('sg-menu-item outline-none data-[state=open]:bg-(--bg-active)', className)} {...props}>
			{icon ? (
				<span className="sg-menu-item__icon">
					<Icon icon={icon} />
				</span>
			) : null}
			<span className="sg-menu-item__label">{children}</span>
			<span className="sg-menu-item__trail gap-1.5">
				{hint ? <span className="text-small text-(--text-3)">{hint}</span> : null}
				<Icon icon={ChevronRight} size={13} className="text-(--text-3)" />
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
					'in-pop z-50 flex max-h-(--radix-dropdown-menu-content-available-height) min-w-[200px] flex-col overflow-y-auto p-1 text-(--text) outline-none',
					'data-[state=open]:animate-in data-[state=open]:fade-in-0',
					className,
				)}
				{...props}
			/>
		</MenuPrimitive.Portal>
	);
}

export function MenuLabel({ children }: { children: ReactNode }) {
	return <SectionLabel className="px-2 pt-1.5 pb-1 text-micro">{children}</SectionLabel>;
}

export function MenuSeparator() {
	return <MenuPrimitive.Separator className="-mx-1 my-1 h-px shrink-0 bg-(--line)" />;
}

/** A picker's trigger, as a quiet pill: the model, repository and branch choosers in a composer's bar. */
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
				'flex shrink-0 items-center gap-[5px] rounded-control font-medium whitespace-nowrap text-(--text-2) transition-colors duration-(--t-fast) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus) data-[state=open]:bg-(--bg-hover) data-[state=open]:text-(--text)',
				height === 28 ? 'h-7 px-2' : 'h-6 px-[7px]',
			)}
			{...rest}
		>
			<Icon icon={icon} size={13} className="text-(--text-3)" />
			<span className="text-small">{label}</span>
			<Icon icon={ChevronDown} size={12} className="text-(--text-3)" />
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
				'flex items-center gap-2 rounded-control text-body text-(--text) outline-none focus-visible:shadow-(--focus) disabled:opacity-45',
				className,
			)}
		>
			<span
				className={cn(
					'relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors duration-(--t)',
					checked ? 'bg-(--accent)' : 'bg-(--track)',
				)}
			>
				<span
					className={cn(
						'absolute top-0.5 left-0.5 size-3 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-(--t) ease-(--ease)',
						checked ? 'translate-x-3' : 'translate-x-0',
					)}
				/>
			</span>
			{label}
		</button>
	);
}

const BAR_TONE = { accent: 'bg-(--accent)', warning: 'bg-(--warn)', danger: 'bg-(--bad)' } as const;

/** A thin meter: how much of something is used, from 0 to 100. */
export function ProgressBar({ value, tone = 'accent', label }: { value: number; tone?: keyof typeof BAR_TONE; label: string }) {
	const clamped = Math.min(100, Math.max(0, value));
	return (
		<div role="progressbar" aria-label={label} aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100} className="h-1 w-full overflow-hidden rounded-full bg-(--bg-active)">
			<div className={cn('h-full rounded-full transition-[width] duration-(--t-fast)', BAR_TONE[tone])} style={{ width: `${clamped}%` }} />
		</div>
	);
}

const BADGE_TONE = {
	neutral: 'bg-(--bg-active) text-(--text-2)',
	accent: 'bg-(--accent-soft) text-(--accent-text)',
	success: 'bg-(--ok-soft) text-(--ok)',
	warning: 'bg-(--warn-soft) text-(--warn)',
	danger: 'bg-(--bad-soft) text-(--bad)',
	merged: 'bg-(--merged-soft) text-(--merged)',
	conflict: 'bg-(--conflict-soft) text-(--conflict)',
	info: 'bg-(--info-soft) text-(--info)',
	outline: 'text-(--text-2) shadow-[inset_0_0_0_1px_var(--line-strong)]',
} as const;

/** A short status word on a row: Connected, Default, Failing. */
export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof BADGE_TONE; children: ReactNode }) {
	return <span className={cn('inline-flex h-[18px] shrink-0 items-center gap-1 rounded-inner px-1.5 text-micro font-medium whitespace-nowrap', BADGE_TONE[tone])}>{children}</span>;
}

/**
 * A filter that toggles on and off, in a row of them. Off is a hairline chip;
 * on takes the soft accent, since a filter is something you act on. A count
 * sits after the name, a mark before it.
 */
export function FilterChip({
	label,
	on,
	onToggle,
	icon,
	mark,
	count,
	size = 'md',
}: {
	label: string;
	on: boolean;
	onToggle: () => void;
	icon?: LucideIcon;
	/** A dot or glyph of its own before the name. */
	mark?: ReactNode;
	count?: number;
	size?: 'sm' | 'md';
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			aria-label={count === undefined ? undefined : `${label}, ${count}`}
			onClick={onToggle}
			className={cn(
				'inline-flex shrink-0 items-center gap-[5px] rounded-control whitespace-nowrap transition-colors duration-(--t-fast) outline-none focus-visible:shadow-(--focus)',
				size === 'sm' ? 'h-[22px] px-2 text-micro' : 'h-6 px-2 text-small',
				on
					? 'bg-(--accent-soft) text-(--accent-text) shadow-[inset_0_0_0_1px_var(--accent-line)]'
					: 'text-(--text-2) shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-(--bg-hover) hover:text-(--text)',
			)}
		>
			{mark}
			{icon ? <Icon icon={icon} size={12} /> : null}
			{label}
			{count === undefined ? null : <span className={cn('in-num', on ? 'opacity-70' : 'text-(--text-3)')}>{count}</span>}
		</button>
	);
}

/**
 * The one search field: a well with a magnifier, the query and a way to clear
 * it. Escape clears it too, or does what `onEscape` says.
 */
export function SearchField({
	value,
	onChange,
	placeholder,
	label,
	size = 'md',
	autoFocus,
	inputRef,
	onEscape,
	trailing,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	/** What a screen reader calls it, when the placeholder is not enough. */
	label?: string;
	size?: 'sm' | 'md';
	autoFocus?: boolean;
	inputRef?: Ref<HTMLInputElement>;
	onEscape?: () => void;
	/** Shown at the end while the field is empty: a shortcut, a count. */
	trailing?: ReactNode;
	className?: string;
}) {
	return (
		<label
			className={cn(
				'sg-field flex min-w-0 items-center gap-1.5 px-2',
				size === 'sm' ? 'h-6' : 'h-7',
				className,
			)}
		>
			<Icon icon={Search} size={size === 'sm' ? 13 : 14} className="text-(--text-3)" />
			<input
				ref={inputRef}
				autoFocus={autoFocus}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key !== 'Escape') return;
					if (onEscape) onEscape();
					else if (value) onChange('');
				}}
				placeholder={placeholder}
				aria-label={label ?? placeholder}
				className={cn('min-w-0 flex-1 border-0 bg-transparent p-0 text-(--text) outline-none placeholder:text-(--text-4)', size === 'sm' ? 'text-small' : 'text-body')}
			/>
			{value ? (
				<button
					type="button"
					aria-label="Clear the search"
					onClick={() => onChange('')}
					className="-mr-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-inner text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
				>
					<Icon icon={X} size={12} />
				</button>
			) : (
				trailing
			)}
		</label>
	);
}
