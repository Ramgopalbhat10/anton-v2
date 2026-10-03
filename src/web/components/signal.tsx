import type { LucideIcon } from 'lucide-react';
import { Check, ChevronDown } from 'lucide-react';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';
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

export function Spinner({ size = 14, tone = 'accent' }: { size?: number; tone?: 'accent' | 'neutral' | 'onAccent' }) {
	return (
		<span
			role="status"
			aria-label="Loading"
			className={cn('sg-spinner', tone !== 'accent' && `sg-spinner--${tone}`)}
			style={{ width: size, height: size }}
		/>
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
	return <code className="sg-code">{children}</code>;
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
		<div className={cn('text-[11px] leading-4 font-medium tracking-[0.06em] uppercase text-(--text-disabled)', className)}>
			{children}
		</div>
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
	title,
	body,
	children,
	className,
}: {
	icon?: LucideIcon;
	title: string;
	body?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn('flex flex-col items-center gap-3 px-6 py-8 text-center', className)}>
			{icon ? (
				<span className="inline-flex size-8 items-center justify-center rounded-md border border-(--border-subtle) bg-(--bg-raised) text-(--icon-tertiary)">
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
					'z-50 flex min-w-[176px] flex-col gap-px rounded-lg bg-(--bg-overlay) p-1 text-(--text-primary) shadow-(--shadow-overlay) outline-none',
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
	className,
	children,
	...props
}: ComponentProps<typeof MenuPrimitive.Item> & { icon?: LucideIcon; checked?: boolean }) {
	return (
		<MenuPrimitive.Item className={cn('sg-menu-item outline-none data-highlighted:bg-(--bg-hover)', className)} {...props}>
			{icon ? (
				<span className="sg-menu-item__icon">
					<Icon icon={icon} />
				</span>
			) : null}
			<span className="sg-menu-item__label">{children}</span>
			<span className="sg-menu-item__trail">
				{checked ? <Icon icon={Check} size={13} className="sg-menu-item__check" /> : null}
			</span>
		</MenuPrimitive.Item>
	);
}

export function MenuLabel({ children }: { children: ReactNode }) {
	return <SectionLabel className="px-2 pt-1.5 pb-1">{children}</SectionLabel>;
}

export function MenuSeparator() {
	return <MenuPrimitive.Separator className="my-1 h-px bg-(--border-subtle)" />;
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
