import type { LucideIcon } from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Icon, Menu, MenuContent, MenuItem, MenuTrigger, SectionLabel } from '@/components/signal';
import { cn } from '@/lib/utils';

export const FIELD =
	'h-8 min-w-0 rounded-lg border border-(--border-subtle) bg-(--well-bg) px-2.5 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)';

/** A settings page's title and what it decides, with actions on the right. */
export function PageHeading({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-start gap-4">
			<div className="flex min-w-0 flex-1 basis-[320px] flex-col gap-2">
				<h1 className="m-0 text-[22px] leading-[28px] font-semibold tracking-[-0.02em]">{title}</h1>
				<p className="m-0 max-w-[72ch] text-[13px] leading-[20px] text-pretty text-(--text-tertiary)">{children}</p>
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
		</div>
	);
}

/** One titled block within a settings page, as a card: a mono title, what it decides, then its rows. */
export function Block({ title, help, children, className, aside }: { title: string; help?: ReactNode; children: ReactNode; className?: string; aside?: ReactNode }) {
	return (
		<section className={cn('in-card', className)} aria-label={title}>
			<header className="flex flex-col gap-1.5 px-4 pt-3.5 pb-1">
				<div className="flex items-center gap-3">
					<SectionLabel className="min-w-0 flex-1">{title}</SectionLabel>
					{aside}
				</div>
				{help ? <p className="m-0 max-w-[76ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{help}</p> : null}
			</header>
			<div className="flex flex-col gap-2 px-4 pt-2 pb-4">{children}</div>
		</section>
	);
}

/** A setting as a row: what it is and what it does, with its control on the right. Rows in a block are ruled apart. */
export function SettingRow({ title, help, children }: { title: ReactNode; help?: ReactNode; children: ReactNode }) {
	return (
		<div className="flex min-h-11 items-center gap-4 border-t border-(--border-subtle) py-2.5 first:border-t-0 first:pt-1">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="text-[13px] font-medium">{title}</div>
				{help ? <div className="max-w-[68ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">{help}</div> : null}
			</div>
			<div className="flex shrink-0 items-center gap-2">{children}</div>
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
	if (success && !pending) return <span className="text-[12px] text-(--success-text)">{saved}</span>;
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
	fallback = 'Custom',
}: {
	label: string;
	icon: LucideIcon;
	value: T;
	options: Array<{ value: T; label: string }>;
	onChange: (value: T) => void;
	help?: ReactNode;
	fallback?: string;
}) {
	const current = options.find((option) => option.value === value);
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<SectionLabel>{label}</SectionLabel>
			<Menu>
				<MenuTrigger asChild>
					<button
						type="button"
						aria-label={label}
						className="flex h-[30px] items-center gap-2 rounded-lg bg-(--bg-overlay) px-2.5 text-left text-[13px] whitespace-nowrap text-(--text-primary) outline-none hover:bg-(--neutral-700) focus-visible:shadow-(--focus-ring)"
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
