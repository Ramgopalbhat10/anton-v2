import type { LucideIcon } from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import { Children, type ReactNode } from 'react';
import { ModelPicker } from '@/components/model-picker';
import { Icon, InfoTip, Menu, MenuContent, MenuItem, MenuTrigger, SectionLabel, Switch } from '@/components/signal';
import type { HelperAgent, Reasoning } from '@/lib/api';
import { cn } from '@/lib/utils';
import { StatusDot } from '@/components/instrument';

export const FIELD =
	'h-8 min-w-0 rounded-card border border-(--line) bg-(--bg-raised) px-2.5 text-body text-(--text) outline-none placeholder:text-(--text-4) focus-visible:shadow-(--focus)';

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
				<h1 className="m-0 flex min-w-0 items-center gap-2 text-h1 leading-[28px] font-semibold tracking-[-0.02em]">
					<span className="min-w-0 truncate">{title}</span>
					{info ? <InfoTip label={`About ${title}`}>{info}</InfoTip> : null}
				</h1>
				{children ? <p className="m-0 max-w-[72ch] text-body leading-[20px] text-pretty text-(--text-3)">{children}</p> : null}
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
		</div>
	);
}

/**
 * One titled block within a settings page: its title and what it decides sit
 * above, and its rows in a card below, with a footer for the save that
 * applies them. A product's block shows its own mark by its title; `info` is
 * the rest of what it decides, behind an icon by its title. `className` dresses
 * the card (a danger zone's red edge, say).
 */
export function Block({
	title,
	mark,
	help,
	info,
	children,
	className,
	aside,
	footer,
}: {
	title: string;
	/** Kept for callers; blocks no longer draw an icon by their title. */
	icon?: LucideIcon;
	mark?: ReactNode;
	help?: ReactNode;
	info?: ReactNode;
	children?: ReactNode;
	className?: string;
	aside?: ReactNode;
	footer?: ReactNode;
}) {
	// Rows shown only in some states leave nothing behind when none show.
	const rows = Children.toArray(children).length > 0;
	return (
		<section className="flex flex-col gap-2.5" aria-label={title}>
			<header className="flex min-h-7 items-end gap-3 px-0.5">
				{mark ? <span className="shrink-0 self-center">{mark}</span> : null}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2 className="m-0 flex min-w-0 items-center gap-1.5 text-body-lg leading-[20px] font-medium tracking-[-0.005em]">
						<span className="min-w-0 truncate">{title}</span>
						{info ? <InfoTip label={`About ${title}`}>{info}</InfoTip> : null}
					</h2>
					{help ? <p className="m-0 max-w-[76ch] text-body leading-[18px] text-pretty text-(--text-3)">{help}</p> : null}
				</div>
				{aside ? <div className="flex shrink-0 items-center gap-2 self-center">{aside}</div> : null}
			</header>
			{rows || footer ? (
				<div className={cn('in-card settings-group', className)}>
					{rows ? <div className="flex flex-col gap-2.5 px-4 py-3">{children}</div> : null}
					{footer ? <footer className="mt-auto flex min-h-[48px] flex-wrap items-center justify-end gap-3 border-t border-(--line) px-4 py-2">{footer}</footer> : null}
				</div>
			) : null}
		</section>
	);
}

/** A part of a block under its own mono label, ruled off from what is above it. */
export function SubBlock({ label, help, info, children }: { label?: string; help?: ReactNode; info?: ReactNode; children: ReactNode }) {
	return (
		<div className="-mx-4 mt-2 flex flex-col gap-2 border-t border-(--line) px-4 pt-3.5">
			{label ? (
				<SectionLabel className="flex items-center gap-1.5">
					{label}
					{info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
				</SectionLabel>
			) : null}
			{help ? <p className="m-0 max-w-[76ch] text-small leading-[18px] text-pretty text-(--text-3)">{help}</p> : null}
			{children}
		</div>
	);
}

/** A line of explanation in a card, with the rest behind an info icon at its end. */
export function Note({ children, info, className }: { children: ReactNode; info?: ReactNode; className?: string }) {
	return (
		<p className={cn('m-0 max-w-[72ch] text-small leading-[18px] text-pretty text-(--text-3)', className)}>
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

/** The icon at the start of a list row: a bare glyph, no tile behind it. */
export function RowIcon({ icon }: { icon: LucideIcon }) {
	return (
		<span className="inline-flex size-8 shrink-0 items-center justify-center text-(--text-2)">
			<Icon icon={icon} size={17} />
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
		<div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2 border-t border-(--line) py-3 first:border-t-0 first:pt-0.5 last:pb-0.5">
			<div className="flex min-w-0 flex-1 basis-[200px] flex-col gap-0.5">
				<div className="text-body font-medium">
					<Titled info={info}>{title}</Titled>
				</div>
				{help ? <div className="max-w-[68ch] text-small leading-[18px] text-pretty text-(--text-3)">{help}</div> : null}
			</div>
			<div className="ml-auto flex max-w-full min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
		</div>
	);
}

/** Rows of one kind (repositories, sandboxes, problems): a card of its own, or plain rows inside a block. */
export function List({ children }: { children: ReactNode }) {
	return <div className="in-list in-card flex flex-col gap-0.5">{children}</div>;
}

/** The helper agents a model can be picked for, as Settings › General and a project's settings list them. */
export const HELPERS: Array<{ agent: HelperAgent; title: string; help: string; info?: string }> = [
	{ agent: 'explorer', title: 'Explorer', help: 'Reads and searches the code.' },
	{ agent: 'tester', title: 'Tester', help: 'Runs the tests and reports failures.' },
	{ agent: 'browser', title: 'Browser', help: 'Works on web pages.', info: 'In the Browser panel or the sandbox, and reports back.' },
	{
		agent: 'computer',
		title: 'Computer',
		help: 'Uses the sandbox desktop.',
		info: "Apps, dialogs, a visual check. It sees the screen with this model when it is an OpenRouter model that reads images, else with the task's, else with ANTON_VISION_MODEL.",
	},
	{ agent: 'reviewer', title: 'Reviewer', help: 'Reviews pull requests on GitHub.', info: 'Each pull request the agent opens or updates.' },
];

export type AgentModelChoice = { model: string; reasoning: Reasoning | null };

/** One helper agent: `fallbackLabel` is what it runs on with its switch off — the task's model, or what a project inherits. */
export function HelperModel({
	title,
	help,
	info,
	value,
	fallback,
	fallbackLabel = "Task's model",
	disabled,
	onChange,
}: {
	title: string;
	help: string;
	info?: string;
	value: AgentModelChoice | null;
	fallback: string;
	fallbackLabel?: ReactNode;
	disabled: boolean;
	onChange: (value: AgentModelChoice | null) => void;
}) {
	return (
		<SettingRow title={title} help={help} info={info}>
			{value ? (
				<ModelPicker
					value={value}
					onChange={(change) => onChange({ model: change.model ?? value.model, reasoning: change.reasoning !== undefined ? change.reasoning : value.reasoning })}
					height={28}
					side="bottom"
				/>
			) : (
				<span className="text-small text-(--text-3)">{fallbackLabel}</span>
			)}
			<Switch
				checked={value !== null}
				disabled={disabled || !fallback}
				onChange={(on) => onChange(on ? { model: fallback, reasoning: null } : null)}
				label={<span className="sr-only">{title} uses its own model</span>}
			/>
		</SettingRow>
	);
}

export function size(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Inline result of a save: saving, saved, or what went wrong. */
export function SaveState({ pending, success, error, saved = 'Saved.' }: { pending: boolean; success: boolean; error: Error | null; saved?: string }) {
	if (error) return <span className="text-small text-(--bad)">{error.message}</span>;
	if (success && !pending)
		return (
			<span className="inline-flex items-center gap-1.5 text-small text-(--ok)">
				<StatusDot tone="success" />
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
						className="flex h-8 items-center gap-2 rounded-card border border-(--line) bg-(--bg-raised) px-2.5 text-left text-body whitespace-nowrap text-(--text) outline-none hover:border-(--line-strong) focus-visible:shadow-(--focus) data-[state=open]:border-(--line-strong)"
					>
						<Icon icon={icon} size={12} className="text-(--text-3)" />
						<span className="min-w-0 flex-1 truncate">{current?.label ?? fallback}</span>
						<Icon icon={ChevronDown} size={12} className="text-(--text-3)" />
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
			{help ? <div className="text-small text-pretty text-(--text-4)">{help}</div> : null}
		</div>
	);
}
