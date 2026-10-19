import type { LucideIcon } from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconTile } from '@/components/instrument';
import { Icon, InfoTip, Menu, MenuContent, MenuItem, MenuTrigger, SectionLabel } from '@/components/signal';
import { cn } from '@/lib/utils';

export const FIELD =
	'h-8 min-w-0 rounded-lg border border-(--border-subtle) bg-(--well-bg) px-2.5 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)';

/** A title with its info icon beside it, when there is more to say than its one line. */
function Titled({ children, info }: { children: ReactNode; info?: ReactNode }) {
	if (!info) return <>{children}</>;
	return (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			<span className="min-w-0 truncate">{children}</span>
			<InfoTip>{info}</InfoTip>
		</span>
	);
}

/** A settings page's title and what it decides in a line, with actions on the right. */
export function PageHeading({ title, children, info, actions }: { title: string; children?: ReactNode; info?: ReactNode; actions?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-start gap-4">
			<div className="flex min-w-0 flex-1 basis-[280px] flex-col gap-1.5">
				<h1 className="m-0 flex min-w-0 items-center gap-2 text-[22px] leading-[28px] font-semibold tracking-[-0.02em]">
					<span className="min-w-0 truncate">{title}</span>
					{info ? <InfoTip label={`About ${title}`}>{info}</InfoTip> : null}
				</h1>
				{children ? <p className="m-0 max-w-[72ch] text-[13px] leading-[20px] text-pretty text-(--text-tertiary)">{children}</p> : null}
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
		</div>
	);
}

/**
 * One titled block within a settings page, as a card: an icon tile and title,
 * what it decides, then its rows, and a footer for the save that applies them.
 * A product's block shows its own mark in place of the icon; `info` is the
 * rest of what it decides, behind an icon by its title.
 */
export function Block({
	title,
	icon,
	mark,
	help,
	info,
	children,
	className,
	aside,
	footer,
}: {
	title: string;
	icon?: LucideIcon;
	mark?: ReactNode;
	help?: ReactNode;
	info?: ReactNode;
	children?: ReactNode;
	className?: string;
	aside?: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<section className={cn('in-card', className)} aria-label={title}>
			<header className="flex items-start gap-3 px-4 pt-3.5 pb-1">
				{mark || icon ? <span className="mt-px">{mark ?? (icon ? <IconTile icon={icon} /> : null)}</span> : null}
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex min-h-[26px] flex-wrap items-center gap-x-3 gap-y-1">
						<h2 className="m-0 flex min-w-0 flex-1 items-center gap-1.5 text-[13px] leading-[18px] font-medium tracking-[-0.005em]">
							<span className="min-w-0 truncate">{title}</span>
							{info ? <InfoTip label={`About ${title}`}>{info}</InfoTip> : null}
						</h2>
						{aside}
					</div>
					{help ? <p className="m-0 max-w-[76ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{help}</p> : null}
				</div>
			</header>
			{children ? <div className="flex flex-col gap-2 px-4 pt-2 pb-4">{children}</div> : <div className="h-3" />}
			{footer ? <footer className="mt-auto flex min-h-[52px] flex-wrap items-center justify-end gap-3 border-t border-(--border-subtle) px-4 py-2.5">{footer}</footer> : null}
		</section>
	);
}

/** A part of a block under its own mono label, ruled off from what is above it. */
export function SubBlock({ label, help, info, children }: { label?: string; help?: ReactNode; info?: ReactNode; children: ReactNode }) {
	return (
		<div className="-mx-4 mt-2 flex flex-col gap-2 border-t border-(--border-subtle) px-4 pt-3.5">
			{label ? (
				<SectionLabel className="flex items-center gap-1.5">
					{label}
					{info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
				</SectionLabel>
			) : null}
			{help ? <p className="m-0 max-w-[76ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{help}</p> : null}
			{children}
		</div>
	);
}

/** A line of explanation in a card, with the rest behind an info icon at its end. */
export function Note({ children, info, className }: { children: ReactNode; info?: ReactNode; className?: string }) {
	return (
		<p className={cn('m-0 max-w-[72ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)', className)}>
			{children}
			{info ? (
				<>
					{' '}
					<InfoTip>{info}</InfoTip>
				</>
			) : null}
		</p>
	);
}

/** The icon at the start of a list row, on the same tile the cards use. */
export function RowIcon({ icon }: { icon: LucideIcon }) {
	return (
		<span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-(--border-subtle) bg-(--well-bg) text-(--icon-secondary)">
			<Icon icon={icon} size={14} />
		</span>
	);
}

/**
 * A setting as a row: what it is in a line, with its control on the right;
 * `info` is the rest, behind an icon by its title. On a phone a wide control
 * drops below. Rows in a block are ruled apart.
 */
export function SettingRow({ title, help, info, children }: { title: ReactNode; help?: ReactNode; info?: ReactNode; children: ReactNode }) {
	return (
		<div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2 border-t border-(--border-subtle) py-2.5 first:border-t-0 first:pt-1">
			<div className="flex min-w-0 flex-1 basis-[200px] flex-col gap-0.5">
				<div className="text-[13px] font-medium">
					<Titled info={info}>{title}</Titled>
				</div>
				{help ? <div className="max-w-[68ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{help}</div> : null}
			</div>
			<div className="ml-auto flex max-w-full min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
		</div>
	);
}

/** Rows of one kind (repositories, sandboxes, problems): a card of its own, or plain rows inside a block. */
export function List({ children }: { children: ReactNode }) {
	return <div className="in-list in-card flex flex-col gap-0.5">{children}</div>;
}

export function size(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Inline result of a save: saving, saved, or what went wrong. */
export function SaveState({ pending, success, error, saved = 'Saved.' }: { pending: boolean; success: boolean; error: Error | null; saved?: string }) {
	if (error) return <span className="text-[12px] text-(--danger-text)">{error.message}</span>;
	if (success && !pending)
		return (
			<span className="inline-flex items-center gap-1.5 text-[12px] text-(--success-text)">
				<span className="size-1.5 shrink-0 rounded-full bg-(--success-base)" />
				{saved}
			</span>
		);
	return null;
}

/** A labelled dropdown of fixed choices; a value outside them shows as `fallback`. */
export function Select<T extends string | number | null>({
	label,
	icon,
	value,
	options,
	onChange,
	help,
	info,
	fallback = 'Custom',
}: {
	label: string;
	icon: LucideIcon;
	value: T;
	options: Array<{ value: T; label: string }>;
	onChange: (value: T) => void;
	help?: ReactNode;
	info?: ReactNode;
	fallback?: string;
}) {
	const current = options.find((option) => option.value === value);
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<SectionLabel className="flex items-center gap-1.5">
				{label}
				{info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
			</SectionLabel>
			<Menu>
				<MenuTrigger asChild>
					<button
						type="button"
						aria-label={label}
						className="flex h-8 items-center gap-2 rounded-lg border border-(--border-subtle) bg-(--well-bg) px-2.5 text-left text-[13px] whitespace-nowrap text-(--text-primary) outline-none hover:border-(--border-default) focus-visible:shadow-(--focus-ring) data-[state=open]:border-(--border-strong)"
					>
						<Icon icon={icon} size={12} className="text-(--icon-tertiary)" />
						<span className="min-w-0 flex-1 truncate">{current?.label ?? fallback}</span>
						<Icon icon={ChevronDown} size={12} className="text-(--icon-tertiary)" />
					</button>
				</MenuTrigger>
				<MenuContent align="start" className="min-w-[220px]">
					{options.map((option) => (
						<MenuItem key={String(option.value)} checked={option.value === value} onSelect={() => onChange(option.value)}>
							{option.label}
						</MenuItem>
					))}
				</MenuContent>
			</Menu>
			{help ? <div className="text-[12px] text-pretty text-(--text-disabled)">{help}</div> : null}
		</div>
	);
}
