import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Check, ChevronDown, Pin, Search, SlidersHorizontal, X, Zap } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { type KeyboardEvent, memo, type PointerEvent, type ReactNode, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Count, StatusDot } from '@/components/instrument';
import { EmptyLine, Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger, Spinner } from '@/components/signal';
import { api, type ModelChoice, type ModelInfo, type ModelRoute, type Reasoning, REASONING_LEVELS } from '@/lib/api';
import { RouteBadge, RouteControls } from '@/components/route-menu';
import { parseRouted, routable, routedId, routeForModel, unrouted } from '../../core/model-route';
import {
	dollars,
	effectiveReasoning,
	type Filter,
	FILTERS,
	listedModels,
	type ModelOptions,
	optionsOf,
	REASONING_LABEL,
	reasoningStrength,
	recentModels,
	rememberModel,
	shortName,
	type Sort,
	SORTS,
	sourceOf,
	sourcesOf,
	tokens,
	vendorHue,
	visibleModels,
} from '@/lib/model-catalog';
import { logoFor, vendorSlug } from '@/lib/provider-logos';
import { cn } from '@/lib/utils';

/** Rendering every match would be slow; search narrows the rest. */
const LIMIT = 60;

/** Every source at once. */
const ALL = 'All';

type ModelList = Awaited<ReturnType<typeof api.models>>;

/** The list as this browser last fetched it, shown while the server answers, so the picker never opens empty. */
const SAVED_KEY = 'anton.models';

function savedModels(): ModelList | undefined {
	try {
		const raw = localStorage.getItem(SAVED_KEY);
		return raw ? (JSON.parse(raw) as ModelList) : undefined;
	} catch {
		return undefined;
	}
}

async function fetchModels(): Promise<ModelList> {
	const list = await api.models();
	try {
		localStorage.setItem(SAVED_KEY, JSON.stringify(list));
	} catch {
		// Storage full or blocked: the next visit waits for the server, as before.
	}
	return list;
}

export function useModels() {
	return useQuery({ queryKey: ['models'], queryFn: fetchModels, staleTime: 10 * 60_000, placeholderData: savedModels });
}

/**
 * The model's vendor on a small tile: its logo when the set has one, else two
 * letters in the vendor's hue. A model on your plan gets a lit corner.
 */
export function ModelMark({ model, size = 16 }: { model: ModelInfo; size?: number }) {
	const logo = logoFor(model);
	const hue = vendorHue(model.vendor);
	return (
		<span
			aria-hidden
			title={model.vendor}
			className="relative inline-flex shrink-0 items-center justify-center rounded-control font-semibold uppercase"
			style={
				logo
					? { width: size, height: size, fontSize: Math.round(size * 0.72), background: 'var(--bg-active)', boxShadow: 'inset 0 0 0 1px var(--line)' }
					: { width: size, height: size, fontSize: size * 0.45, color: hue, background: `${hue}1f`, boxShadow: `inset 0 0 0 1px ${hue}33` }
			}
		>
			{logo ? (
				// The set's own files, sized by font size and drawn in the text colour where they have one colour.
				<span className="flex text-(--text)" dangerouslySetInnerHTML={{ __html: logo }} />
			) : (
				model.vendor.replace(/[^a-z0-9]/gi, '').slice(0, 2)
			)}
			{model.subscription ? <span className="absolute -top-[2px] -right-[2px] size-[6px] rounded-full bg-(--accent) shadow-[0_0_0_1.5px_var(--bg-overlay)]" /> : null}
		</span>
	);
}

/** A model's vendor logo on a small tile by its id alone, or its initials when the set has no logo: for rows that name a model without its catalog entry. */
export function ModelLogo({ model, size = 16, title }: { model: string; size?: number; title?: string }) {
	const logo = logoFor({ id: model });
	const vendor = vendorSlug({ id: model });
	const hue = vendorHue(vendor);
	return (
		<span
			aria-hidden={title ? undefined : true}
			title={title}
			className="inline-flex shrink-0 items-center justify-center rounded-control font-semibold uppercase"
			style={
				logo
					? { width: size, height: size, fontSize: Math.round(size * 0.68), background: 'var(--bg-active)', boxShadow: 'inset 0 0 0 1px var(--line)' }
					: { width: size, height: size, fontSize: size * 0.45, color: hue, background: `${hue}1f`, boxShadow: `inset 0 0 0 1px ${hue}33` }
			}
		>
			{logo ? <span className="flex text-(--text)" dangerouslySetInnerHTML={{ __html: logo }} /> : vendor.replace(/[^a-z0-9]/gi, '').slice(0, 2)}
		</span>
	);
}

/** A model's name as the catalog gives it, else the last part of its id. */
export function useModelName(): (model: string) => string {
	const models = useModels();
	const byId = useMemo(() => new Map((models.data?.models ?? []).map((model) => [model.id, shortName(model)] as const)), [models.data]);
	return (id) => {
		const model = unrouted(id);
		return byId.get(model) ?? (model.split('/').pop() ?? model).replace(/^~/, '');
	};
}

/** Rising bars: how hard the model reasons, on its own scale. */
function ReasoningMeter({ strength, className }: { strength: number; className?: string }) {
	return (
		<span aria-hidden className={cn('inline-flex h-2.5 items-end gap-px', className)}>
			{[0.25, 0.5, 0.75, 1].map((step) => (
				<span
					key={step}
					className={cn('w-[2px] rounded-full', strength >= step ? 'bg-(--accent)' : 'bg-(--line-strong)')}
					style={{ height: `${30 + step * 70}%` }}
				/>
			))}
		</span>
	);
}

/**
 * The efforts a model accepts, as rising bars along every level there is:
 * lit where it accepts one, brightest at its default. "low – max" beside it.
 */
export function EffortRange({ levels, preferred, className }: { levels: Reasoning[]; preferred: Reasoning; className?: string }) {
	const scale = REASONING_LEVELS.filter((level) => level !== 'minimal' || levels.includes('minimal'));
	const on = levels.filter((level) => level !== 'off');
	if (!on.length) return <span className={cn('in-caption tracking-normal normal-case', className)}>no reasoning</span>;
	return (
		<span className={cn('inline-flex items-center gap-2', className)} title={`Effort ${on.map((level) => REASONING_LABEL[level]).join(', ')}; ${REASONING_LABEL[preferred]} by default`}>
			<span aria-hidden className="inline-flex h-3 items-end gap-[2px]">
				{scale.map((level, index) => (
					<span
						key={level}
						className="w-[3px] rounded-mark"
						style={{
							height: `${25 + (index / (scale.length - 1)) * 75}%`,
							background: level === preferred ? 'var(--accent)' : levels.includes(level) ? 'var(--text-3)' : 'var(--bg-active)',
						}}
					/>
				))}
			</span>
			<span className="in-num text-micro whitespace-nowrap text-(--text-3)">
				{REASONING_LABEL[on[0]].toLowerCase()} – {REASONING_LABEL[on[on.length - 1]].toLowerCase()}
			</span>
		</span>
	);
}

/**
 * The columns every row and section header share, so context and prices
 * line up down the list: mark, name, context, input price, output price,
 * check. Fixed widths fit the longest labels ("262K", "$0.435").
 */
/** Rows drawn when the list opens: a few screens, before the rest follow. */
const FIRST_ROWS = 40;

const COLUMNS = 'grid grid-cols-[16px_minmax(0,1fr)_32px_40px_40px_12px] items-center gap-x-1 px-2 @min-[350px]/picker:gap-x-2';

/**
 * What a million tokens cost, in and out, in their own columns; a free
 * model's fills both with one word, and a plan's is left blank, since the dot
 * on its mark already says it is on a plan.
 */
function PriceCells({ model }: { model: ModelInfo }) {
	if (model.subscription) return <span className="col-span-2" />;
	if (model.price.input === 0 && model.price.output === 0) {
		return <span className="col-span-2 text-right text-micro text-(--ok)">Free</span>;
	}
	return (
		<>
			<span className="in-num text-right text-micro text-(--text-3)">{dollars(model.price.input)}</span>
			<span className="in-num text-right text-micro text-(--text-2)">{dollars(model.price.output)}</span>
		</>
	);
}

/** What a row's tooltip says: the model in full, and what it costs. */
function about(model: ModelInfo): string {
	const billing = model.subscription ? `on your ${model.subscription} plan` : `${dollars(model.price.input)} in · ${dollars(model.price.output)} out per 1M tokens`;
	return [`${model.vendor}: ${model.name}`, `${tokens(model.contextLength)} context · ${billing}`, model.description].filter(Boolean).join('\n');
}

/**
 * One line per model on the shared columns: its mark (the vendor shows on
 * hover), its name with a pin beside it, its context, and what it costs. The
 * pin shows on hover, and stays lit on a pinned model. In a section with no
 * prices (a plan's), the context sits at the right edge, where the prices would.
 * A model on a gateway has its routing menus after the pin: on hover, and
 * always on the chosen model.
 */
const ModelRow = memo(function ModelRow({
	model,
	index,
	selected,
	active,
	pinned,
	priced,
	onPick,
	onHover,
	onPin,
	routing,
}: {
	model: ModelInfo;
	/** Its place in the whole list, which the keys and the pointer move through. */
	index: number;
	selected: boolean;
	active: boolean;
	pinned: boolean;
	priced: boolean;
	/** The same functions for every row and every render, so moving the pointer redraws only the two rows it moves between. */
	onPick: (model: ModelInfo) => void;
	onHover: (index: number) => void;
	onPin: (model: ModelInfo) => void;
	routing?: ReactNode;
}) {
	return (
		// The list's keys pick the active row (see ModelPicker), so the row itself takes no focus; its pin does.
		<div
			role="option"
			aria-selected={selected}
			data-active={active || undefined}
			onClick={() => onPick(model)}
			onMouseMove={active ? undefined : () => onHover(index)}
			title={about(model)}
			className={cn(COLUMNS, 'group/row h-8 w-full cursor-default rounded-control text-left outline-none data-active:bg-(--bg-hover)')}
		>
			<ModelMark model={model} />
			<span className="flex min-w-0 items-center gap-1">
				<span className={cn('min-w-0 truncate text-body', selected ? 'text-(--accent-text)' : 'text-(--text)')}>{shortName(model)}</span>
				<button
					type="button"
					aria-label={`${pinned ? 'Unpin' : 'Pin'} ${model.name}`}
					aria-pressed={pinned}
					title={pinned ? 'Unpin' : 'Pin to the top'}
					onClick={(event) => {
						event.stopPropagation();
						onPin(model);
					}}
					className={cn(
						'inline-flex size-5 shrink-0 items-center justify-center rounded-control outline-none transition-opacity duration-(--t-fast) hover:bg-(--bg-active) focus-visible:opacity-100 focus-visible:shadow-(--focus)',
						pinned ? 'text-(--accent-text) opacity-100' : 'text-(--text-3) opacity-0 group-hover/row:opacity-100 group-data-active/row:opacity-100',
					)}
				>
					<Icon icon={Pin} size={11} className={cn('rotate-45', pinned && '[&_path]:fill-current')} />
				</button>
				{routing}
			</span>
			{priced ? null : <span className="col-span-2" />}
			<span className="in-num text-right text-micro text-(--text-4)">{tokens(model.contextLength)}</span>
			{priced ? <PriceCells model={model} /> : null}
			<span className="flex justify-end text-(--accent-text)">{selected ? <Icon icon={Check} size={12} /> : null}</span>
		</div>
	);
});

/**
 * The model's efforts along one ramp of thin ticks rising left to right, lit
 * up to the end of the chosen level; a dot marks the model's default. Click a
 * level, drag along the row, or use the arrow keys.
 */
export function EffortTrack({ model, value, onChange }: { model?: ModelInfo; value: Reasoning; onChange: (level: Reasoning) => void }) {
	const row = useRef<HTMLDivElement>(null);
	if (!model?.reasoning.length) return <span className="text-micro text-(--text-4)">No reasoning step</span>;
	const levels = model.reasoning;
	const chosen = Math.max(0, levels.indexOf(value));

	function onPointer(event: PointerEvent<HTMLDivElement>) {
		if (event.type === 'pointerdown') event.currentTarget.setPointerCapture?.(event.pointerId);
		else if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
		const box = row.current!.getBoundingClientRect();
		const index = Math.min(levels.length - 1, Math.max(0, Math.floor(((event.clientX - box.left) / Math.max(1, box.width)) * levels.length)));
		if (levels[index] !== value) onChange(levels[index]);
	}
	function onKeyDown(event: KeyboardEvent) {
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		event.stopPropagation();
		onChange(levels[Math.min(levels.length - 1, Math.max(0, chosen + step))]);
	}

	// One ramp of thin ticks rising left to right, a few per level, lit up to the end of the chosen level.
	const PER = 7;
	const total = levels.length * PER;
	const litUpTo = (chosen + 1) * PER - 1;

	return (
		<div
			ref={row}
			role="radiogroup"
			aria-label="Reasoning effort"
			onKeyDown={onKeyDown}
			onPointerDown={onPointer}
			onPointerMove={onPointer}
			className="grid min-w-0 flex-1 touch-none"
			style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}
		>
			{levels.map((level, index) => {
				const isDefault = level === model.defaultReasoning;
				return (
					<button
						type="button"
						role="radio"
						aria-checked={index === chosen}
						tabIndex={index === chosen ? 0 : -1}
						key={level}
						onClick={() => onChange(level)}
						title={isDefault ? "The model's default" : undefined}
						className="group/level flex min-w-0 flex-col items-stretch gap-1 rounded-control pt-1 pb-0.5 outline-none focus-visible:shadow-(--focus)"
					>
						<span aria-hidden className="flex h-5 items-end justify-around px-[3px]">
							{Array.from({ length: PER }, (_, tick) => {
								const at = index * PER + tick;
								const lit = at <= litUpTo;
								return (
									<span
										key={tick}
										className={cn('w-[2px] rounded-full transition-colors duration-(--t-fast)', !lit && 'bg-(--bg-active) group-hover/level:bg-(--line-strong)')}
										style={{
											height: `${22 + (at / (total - 1)) * 78}%`,
											...(lit ? { background: 'var(--accent)', opacity: 0.3 + 0.7 * (at / Math.max(1, litUpTo)) } : {}),
										}}
									/>
								);
							})}
						</span>
						<span
							className={cn(
								'flex items-center justify-center gap-1 truncate text-nano transition-colors duration-(--t-fast)',
								index === chosen ? 'text-(--text)' : 'text-(--text-4) group-hover/level:text-(--text-2)',
							)}
						>
							{REASONING_LABEL[level]}
							{isDefault ? <span aria-hidden className="size-1 shrink-0 rounded-full bg-current opacity-60" /> : null}
						</span>
					</button>
				);
			})}
		</div>
	);
}

/**
 * The context sizes a model comes in, as a segmented ruler: each segment's
 * ticks run as far as its share of the largest, so the standard window reads
 * as a fraction of the 1M one at a glance. Click one, or use the arrow keys.
 */
export function ContextRuler({ options, onChange }: { options: ModelOptions; onChange: (context: string | null) => void }) {
	const sizes = options.contexts;
	const largest = Math.max(...sizes.map((size) => size.tokens));
	const chosen = Math.max(
		0,
		sizes.findIndex((size) => size.tag === options.chosen.context),
	);
	const TICKS = 12;
	function onKeyDown(event: KeyboardEvent) {
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		event.stopPropagation();
		onChange(sizes[Math.min(sizes.length - 1, Math.max(0, chosen + step))].tag);
	}
	return (
		<div role="radiogroup" aria-label="Context window" onKeyDown={onKeyDown} className="inline-flex shrink-0 gap-0.5 rounded-control bg-(--bg-active) p-0.5">
			{sizes.map((size, index) => {
				const on = index === chosen;
				const lit = Math.max(1, Math.round((size.tokens / largest) * TICKS));
				return (
					<button
						type="button"
						role="radio"
						aria-checked={on}
						tabIndex={on ? 0 : -1}
						key={size.tag ?? 'standard'}
						onClick={() => onChange(size.tag)}
						title={size.tag ? `Up to ${tokens(size.tokens)} tokens of context` : `The standard ${tokens(size.tokens)} window`}
						className={cn(
							'group/size flex flex-col items-start gap-[3px] rounded-control px-2 pt-[3px] pb-1 outline-none transition-colors duration-(--t-fast) focus-visible:shadow-(--focus)',
							on ? 'bg-(--bg-active) shadow-[inset_0_0_0_1px_var(--line)]' : 'hover:bg-(--bg-active)',
						)}
					>
						<span className={cn('in-num text-micro leading-none', on ? 'text-(--text)' : 'text-(--text-3) group-hover/size:text-(--text-2)')}>
							{tokens(size.tokens)}
						</span>
						<span aria-hidden className="flex h-[5px] items-end gap-[2px]">
							{Array.from({ length: TICKS }, (_, tick) => (
								<span
									key={tick}
									className="w-px rounded-full"
									style={{
										height: tick === lit - 1 ? '100%' : '60%',
										background: tick >= lit ? 'var(--bg-active)' : on ? 'var(--accent)' : 'var(--text-4)',
									}}
								/>
							))}
						</span>
					</button>
				);
			})}
		</div>
	);
}

/** Fast mode as a bolt that lights up and a small switch; its title says what it costs. */
export function FastToggle({ on, note, onChange }: { on: boolean; note?: string; onChange: (on: boolean) => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-label="Fast mode"
			title={note}
			onClick={() => onChange(!on)}
			className={cn(
				'inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-control pr-1.5 pl-2 text-small outline-none transition-colors duration-(--t-fast) focus-visible:shadow-(--focus)',
				on ? 'bg-(--accent-soft) text-(--accent-text)' : 'text-(--text-3) hover:bg-(--bg-active) hover:text-(--text-2)',
			)}
		>
			<Icon icon={Zap} size={12} className={cn(on && 'drop-shadow-[0_0_4px_var(--accent)] [&_path]:fill-current')} />
			Fast
			<span className={cn('relative ml-0.5 inline-flex h-3 w-[22px] rounded-full transition-colors duration-(--t-fast)', on ? 'bg-(--accent)' : 'bg-(--track)')}>
				<span className={cn('absolute top-0.5 size-2 rounded-full bg-white transition-transform duration-(--t-fast)', on ? 'translate-x-3' : 'translate-x-0.5')} />
			</span>
		</button>
	);
}

/**
 * Which providers' models to list, any number at once. With none chosen it is
 * a quiet icon; with some, their logos side by side and a button to clear them.
 */
function ProviderFilter({
	providers,
	chosen,
	onToggle,
	onClear,
}: {
	providers: Array<{ vendor: string; count: number; model: ModelInfo }>;
	chosen: Set<string>;
	onToggle: (vendor: string) => void;
	onClear: () => void;
}) {
	const picked = providers.filter((entry) => chosen.has(entry.vendor));
	return (
		<span className={cn('flex shrink-0 items-center rounded-control', picked.length && 'bg-(--accent-soft)')}>
			<Menu>
				<MenuTrigger asChild>
					<button
						type="button"
						aria-label={picked.length ? `Providers: ${picked.map((entry) => entry.vendor).join(', ')}` : 'Filter by provider'}
						title={picked.length ? picked.map((entry) => entry.vendor).join(', ') : 'Filter by provider'}
						className={cn(
							'inline-flex h-7 shrink-0 items-center justify-center rounded-control text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text-2) focus-visible:shadow-(--focus) data-[state=open]:bg-(--bg-hover)',
							picked.length ? 'gap-1 pr-1 pl-1.5' : 'w-7',
						)}
					>
						{picked.length ? (
							<>
								<span className="flex items-center">
									{picked.slice(0, 3).map((entry, index) => (
										<span key={entry.vendor} className={cn('flex rounded-control shadow-[0_0_0_1.5px_var(--bg-overlay)]', index > 0 && '-ml-1')}>
											<ModelMark model={{ ...entry.model, subscription: undefined }} size={15} />
										</span>
									))}
								</span>
								{picked.length > 3 ? <span className="in-num text-nano text-(--accent-text)">+{picked.length - 3}</span> : null}
							</>
						) : (
							<Icon icon={Boxes} size={13} />
						)}
					</button>
				</MenuTrigger>
				<MenuContent align="end" collisionPadding={8} className="max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] min-w-[220px] overflow-y-auto">
					<div className="flex items-center justify-between pr-1">
						<MenuLabel>Providers</MenuLabel>
						{picked.length ? (
							<button
								type="button"
								onClick={onClear}
								className="rounded-control px-1.5 py-0.5 text-micro text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
							>
								Clear {picked.length}
							</button>
						) : null}
					</div>
					{providers.map((entry) => (
						<MenuItem
							key={entry.vendor}
							checked={chosen.has(entry.vendor)}
							hint={entry.count}
							onSelect={(event) => {
								// Several can be chosen, so the menu stays open.
								event.preventDefault();
								onToggle(entry.vendor);
							}}
						>
							<span className="flex min-w-0 items-center gap-2">
								<ModelMark model={{ ...entry.model, subscription: undefined }} size={14} />
								<span className="truncate">{entry.vendor}</span>
							</span>
						</MenuItem>
					))}
				</MenuContent>
			</Menu>
			{picked.length ? (
				<button
					type="button"
					aria-label="Clear the provider filter"
					title="Clear"
					onClick={onClear}
					className="inline-flex size-6 items-center justify-center rounded-control text-(--accent-text) outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
				>
					<Icon icon={X} size={11} />
				</button>
			) : null}
		</span>
	);
}

type Section = { title: string; plan: boolean; models: ModelInfo[]; total: number };

function sectionsFor(models: ModelInfo[], visible: ModelInfo[], browsing: boolean, source: string, pinnedIds: string[]): Section[] {
	const inView = (model: ModelInfo | undefined): model is ModelInfo => model !== undefined && (source === ALL || sourceOf(model) === source);
	// Pins in the order you made them, each shown once at the top.
	const pinned = pinnedIds.map((id) => visible.find((model) => model.id === id)).filter(inView);
	const recent = browsing
		? recentModels()
				.map((id) => models.find((model) => model.id === id))
				.filter(inView)
				.filter((model) => !pinned.includes(model))
		: [];
	const rest = visible.filter((model) => !recent.includes(model) && !pinned.includes(model));
	const pins = { title: 'Pinned', plan: false, models: pinned, total: pinned.length };
	if (!browsing) {
		return [pins, { title: 'Matches', plan: false, models: rest.slice(0, LIMIT), total: rest.length }].filter((section) => section.total > 0);
	}
	// Each source is a section, plans first: their calls cost nothing more.
	const named = [...new Set(rest.map(sourceOf))];
	const isPlan = (group: string) => rest.some((model) => model.subscription && sourceOf(model) === group);
	return [
		pins,
		{ title: 'Recent', plan: false, models: recent, total: recent.length },
		...[...named.filter(isPlan), ...named.filter((group) => !isPlan(group))].map((group) => {
			const members = rest.filter((model) => sourceOf(model) === group);
			return { title: isPlan(group) ? `${group} plan` : group, plan: isPlan(group), models: members.slice(0, LIMIT), total: members.length };
		}),
	].filter((section) => section.total > 0);
}

/** What a model comes in beside its standard self, above its effort: its context sizes and Fast. */
function ModelOptionsRow({ options, note, onChange }: { options: ModelOptions; note?: string; onChange: (change: Partial<ModelOptions['chosen']>) => void }) {
	return (
		<div className="flex items-center gap-3 pt-1.5 pr-2 pl-3">
			<span className="in-caption w-12 shrink-0">Context</span>
			{options.contexts.length > 1 ? (
				<ContextRuler options={options} onChange={(context) => onChange({ context })} />
			) : (
				<span className="in-num text-micro text-(--text-3)">{tokens(options.contexts[0].tokens)}</span>
			)}
			<span className="flex-1" />
			{options.fast ? <FastToggle on={options.chosen.fast} note={note} onChange={(fast) => onChange({ fast })} /> : null}
		</div>
	);
}

/**
 * Compact model chooser: a search, the models in one list with each source
 * (a plan you signed in to, or a gateway) as a section, and the chosen
 * model's effort along the bottom. Source, filters and sort sit in one menu.
 * Picking a model keeps the panel open so its effort can be set; Enter picks
 * and closes. Every gateway model has provider/sort controls. Persisted choices
 * carry routing in their model specifier; tasks can use `onRoute` to retain
 * their existing separate route field. Both use exactly the same controls.
 */
export const ModelPicker = memo(function ModelPicker({
	value: storedValue,
	onChange: onStoredChange,
	route: taskRoute,
	onRoute,
	effort = true,
	side = 'top',
	height = 26,
	only,
}: {
	value: ModelChoice;
	onChange: (change: Partial<ModelChoice>) => void;
	route?: ModelRoute | null;
	/** Legacy task storage: model and route are separate, updated atomically. */
	onRoute?: (route: ModelRoute | null, model?: string) => void;
	/** False for model-only ports (titles), which do not persist reasoning. */
	effort?: boolean;
	side?: 'top' | 'bottom';
	height?: 26 | 28;
	/** The models that can be picked here, when not all can. */
	only?: (model: ModelInfo) => boolean;
}) {
	const parsed = parseRouted(storedValue.model);
	const value = { ...storedValue, model: parsed.model };
	const route = onRoute ? (taskRoute ?? null) : parsed.route;
	function onChange(change: Partial<ModelChoice>) {
		if (!change.model || onRoute) return onStoredChange(change);
		onStoredChange({ ...change, model: routedId(change.model, routeForModel(route, value.model, change.model)) });
	}
	function setRoute(next: ModelRoute | null, picked?: string) {
		if (onRoute) return onRoute(next, picked);
		onStoredChange({ model: routedId(picked ?? value.model, next), reasoning: picked ? null : value.reasoning });
	}
	const models = useModels();
	const [open, setOpen] = useState(false);
	// A plan you could connect is listed in the menu, and named above the list, before it has models.
	const plans = useQuery({ queryKey: ['subscriptions'], queryFn: () => api.subscriptions(), enabled: open, staleTime: 60_000 });
	const [query, setQuery] = useState('');
	const [filters, setFilters] = useState<Set<Filter>>(() => new Set());
	const [sort, setSort] = useState<Sort>('newest');
	const [source, setSource] = useState(ALL);
	const [vendors, setVendors] = useState<Set<string>>(() => new Set());
	const [cursor, setCursor] = useState(0);
	const list = useRef<HTMLDivElement>(null);

	const everything = useMemo(() => (only ? (models.data?.models ?? []).filter(only) : (models.data?.models ?? [])), [models.data, only]);
	// A plan model's larger context and fast mode are its controls along the bottom, not rows.
	const all = useMemo(() => listedModels(everything), [everything]);
	const selected = everything.find((model) => model.id === value.model);
	const options = selected ? optionsOf(everything, selected) : undefined;
	const shown = options?.base;
	const reasoning = effectiveReasoning(selected, value.reasoning);
	const sources = useMemo(
		// OpenRouter has a tab in Subscriptions for its key, but bills per token: a gateway, not a plan.
		() =>
			sourcesOf(
				all,
				(plans.data?.subscriptions ?? []).filter((plan) => plan.kind !== 'gateway').map((plan) => ({ name: plan.name, connected: plan.state === 'connected' })),
			),
		[all, plans.data],
	);
	const unconnected = sources.filter((entry) => entry.plan && !entry.connected && (source === ALL || source === entry.name));
	const fromSource = useMemo(() => (source === ALL ? all : all.filter((model) => sourceOf(model) === source)), [all, source]);
	// The source's providers, busiest first, each with a model to show its logo.
	const providers = useMemo(() => {
		const byVendor = new Map<string, { vendor: string; count: number; model: ModelInfo }>();
		for (const model of fromSource) {
			const entry = byVendor.get(model.vendor);
			if (entry) entry.count++;
			else byVendor.set(model.vendor, { vendor: model.vendor, count: 1, model });
		}
		return [...byVendor.values()].sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor));
	}, [fromSource]);
	const ofVendor = (model: ModelInfo) => vendors.size === 0 || vendors.has(model.vendor);
	const inSource = useMemo(() => fromSource.filter(ofVendor), [fromSource, vendors]);
	const browsing = !query && filters.size === 0;
	const matching = useMemo(() => visibleModels(inSource, query, filters, sort), [inSource, query, filters, sort]);
	const pinnedIds = useMemo(() => models.data?.pinned ?? [], [models.data]);
	const sections = useMemo(() => sectionsFor(all.filter(ofVendor), matching, browsing, source, pinnedIds), [all, vendors, matching, browsing, source, pinnedIds]);
	const flat = sections.flatMap((section) => section.models);
	const active = flat[Math.min(cursor, flat.length - 1)];
	const narrowed = source !== ALL || filters.size > 0 || sort !== 'newest';

	const queryClient = useQueryClient();
	// The list moves the moment you pin; the server's answer, or a failure, settles it.
	const pin = useMutation({
		mutationFn: (pinned: string[]) => api.setPinnedModels(pinned),
		onMutate: (pinned) => {
			const before = queryClient.getQueryData<{ pinned?: string[] }>(['models']);
			queryClient.setQueryData<typeof models.data>(['models'], (current) => (current ? { ...current, pinned } : current));
			return before?.pinned;
		},
		onError: (_error, _pinned, before) => queryClient.setQueryData<typeof models.data>(['models'], (current) => (current ? { ...current, pinned: before } : current)),
	});

	function togglePin(model: ModelInfo) {
		pin.mutate(pinnedIds.includes(model.id) ? pinnedIds.filter((id) => id !== model.id) : [...pinnedIds, model.id]);
	}

	function pick(model: ModelInfo, close: boolean) {
		rememberModel(model.id);
		if (model.id !== shown?.id) {
			// The context and Fast you chose carry over to a model that offers them.
			const next = optionsOf(everything, model);
			const context = options?.chosen.context && next.contexts.some((size) => size.tag === options.chosen.context) ? options.chosen.context : null;
			onChange({ model: next.pick({ context, fast: Boolean(options?.chosen.fast && next.fast) }).id, reasoning: null });
		}
		if (close) setOpen(false);
	}

	function choose(change: Partial<ModelOptions['chosen']>) {
		if (options) onChange({ model: options.pick({ ...options.chosen, ...change }).id });
	}

	function toggleVendor(vendor: string) {
		setCursor(0);
		setVendors((current) => {
			const next = new Set(current);
			if (!next.delete(vendor)) next.add(vendor);
			return next;
		});
	}

	function toggle(filter: Filter) {
		setCursor(0);
		setFilters((current) => {
			const next = new Set(current);
			if (!next.delete(filter)) next.add(filter);
			return next;
		});
	}

	const keys: Record<string, () => void> = {
		ArrowDown: () => setCursor((index) => Math.min(index + 1, flat.length - 1)),
		ArrowUp: () => setCursor((index) => Math.max(index - 1, 0)),
		Enter: () => active && pick(active, true),
	};

	function onKeyDown(event: KeyboardEvent) {
		const handler = keys[event.key];
		// The menu, the effort and context rows, the Fast switch and a focused pin answer their own keys.
		if (!handler || (event.target as HTMLElement).closest('[role=menu],[role=radiogroup],[role=switch],[aria-pressed],[aria-haspopup]')) return;
		event.preventDefault();
		handler();
		requestAnimationFrame(() => list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' }));
	}

	// The rows call the latest pick and pin through these, which never change, so a row redraws only when what it shows does.
	const latest = useRef({ pick, togglePin });
	useLayoutEffect(() => {
		latest.current = { pick, togglePin };
	});
	const onPickRow = useCallback((model: ModelInfo) => latest.current.pick(model, false), []);
	const onPinRow = useCallback((model: ModelInfo) => latest.current.togglePin(model), []);
	// The list opens on its first screens of rows, and draws the rest just after without holding up the opening.
	const [drawAll, setDrawAll] = useState(false);
	useEffect(() => {
		if (!open) return setDrawAll(false);
		const frame = requestAnimationFrame(() => startTransition(() => setDrawAll(true)));
		return () => cancelAnimationFrame(frame);
	}, [open]);
	const drawn = drawAll ? Number.POSITIVE_INFINITY : FIRST_ROWS;

	let offset = 0;
	const routed = selected && !selected.subscription && routable(selected.id) ? selected : undefined;

	/** A gateway row's routing menus: this choice's route on the chosen model, kept in view; on any other, shown on hover, and a pick there picks the model too. */
	function routingFor(model: ModelInfo) {
		if (model.id === shown?.id && routed) return <RouteControls model={routed} route={route} onChange={(next) => setRoute(next)} />;
		return (
			<RouteControls
				model={model}
				route={null}
				onChange={(next) => {
					rememberModel(model.id);
					setRoute(next, model.id);
				}}
				className="hidden group-hover/row:flex group-data-active/row:flex has-data-[state=open]:flex"
			/>
		);
	}

	return (
		<PopoverPrimitive.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				setCursor(0);
			}}
		>
			<PopoverPrimitive.Trigger asChild>
				<button
					type="button"
					aria-label="Model and reasoning"
					title={selected?.subscription ? `${selected.name}, on your ${selected.subscription} plan` : undefined}
					className={cn(
						'flex max-w-[260px] min-w-0 shrink items-center gap-1.5 rounded-card bg-(--bg-overlay) pr-1.5 pl-1 whitespace-nowrap text-(--text-2) transition-colors duration-(--t-fast) outline-none hover:bg-(--bg-active) hover:text-(--text) focus-visible:shadow-(--focus)',
						height === 28 ? 'h-7' : 'h-[26px]',
					)}
				>
					{selected ? <ModelMark model={selected} size={height - 10} /> : <Spinner size={12} tone="neutral" />}
					<span className="min-w-0 truncate text-small">{shown ? shortName(shown) : 'Model'}</span>
					{options?.chosen.context ? (
						<span className="in-num rounded-control bg-(--bg-active) px-1 py-px text-nano text-(--text-2)" title={`${tokens(selected!.contextLength)} context`}>
							{tokens(selected!.contextLength)}
						</span>
					) : null}
					{options?.chosen.fast ? <Icon icon={Zap} size={11} className="text-(--accent-text) [&_path]:fill-current" /> : null}
					{routed && route ? <RouteBadge model={routed} route={route} size={height - 12} /> : null}
					{effort && selected?.reasoning.length ? (
						<span className="flex items-center gap-1 rounded-control bg-(--bg-active) px-1 py-px" title={`Reasoning effort: ${REASONING_LABEL[reasoning]}`}>
							<ReasoningMeter strength={reasoningStrength(selected, reasoning)} />
							{/* On a phone the meter says it alone, so the model keeps its name. */}
							<span className="hidden text-nano text-(--text-3) sm:inline">{REASONING_LABEL[reasoning]}</span>
						</span>
					) : null}
					<Icon icon={ChevronDown} size={12} className="text-(--text-3)" />
				</button>
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					side={side}
					align="start"
					sideOffset={6}
					collisionPadding={12}
					onKeyDown={onKeyDown}
					className="@container/picker z-50 flex h-[min(440px,var(--radix-popover-content-available-height))] min-h-[240px] w-[min(380px,calc(100vw-24px))] in-pop flex-col overflow-hidden text-(--text) outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
				>
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-(--line) pr-1.5 pl-3">
						<Icon icon={Search} size={13} className="text-(--text-3)" />
						<input
							autoFocus
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setCursor(0);
							}}
							placeholder="Search models"
							aria-label="Search models"
							className="min-w-0 flex-1 border-0 bg-transparent p-0 text-body text-(--text) outline-none placeholder:text-(--text-4)"
						/>
						{models.isPending ? null : <Count>{browsing && vendors.size === 0 ? fromSource.length : `${matching.length}/${fromSource.length}`}</Count>}
						{providers.length > 1 ? (
							<ProviderFilter
								providers={providers}
								chosen={vendors}
								onToggle={toggleVendor}
								onClear={() => {
									setVendors(new Set());
									setCursor(0);
								}}
							/>
						) : null}
						<Menu>
							<MenuTrigger asChild>
								<button
									type="button"
									aria-label="Source, filters and sort"
									className={cn(
										'relative inline-flex size-7 shrink-0 items-center justify-center rounded-control text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text-2) focus-visible:shadow-(--focus) data-[state=open]:bg-(--bg-hover)',
										narrowed && 'text-(--accent-text)',
									)}
								>
									<Icon icon={SlidersHorizontal} size={13} />
									{narrowed ? <span className="absolute top-1 right-1 size-1.5 rounded-full bg-(--accent)" /> : null}
								</button>
							</MenuTrigger>
							<MenuContent align="end" collisionPadding={8} className="max-h-(--radix-dropdown-menu-content-available-height) min-w-[200px] overflow-y-auto">
								{sources.length > 1 ? (
									<>
										<MenuLabel>Source</MenuLabel>
										{[{ name: ALL, plan: false, connected: true, count: all.length }, ...sources].map((entry) => (
											<MenuItem
												key={entry.name}
												checked={source === entry.name}
												hint={entry.count}
												onSelect={() => {
													setSource(entry.name);
													setCursor(0);
												}}
											>
												{entry.plan ? `${entry.name} plan` : entry.name}
											</MenuItem>
										))}
										<MenuSeparator />
									</>
								) : null}
								<MenuLabel>Only</MenuLabel>
								{(Object.keys(FILTERS) as Filter[]).map((filter) => (
									<MenuItem
										key={filter}
										checked={filters.has(filter)}
										hint={inSource.filter(FILTERS[filter].test).length}
										onSelect={(event) => {
											// Filters stack, so the menu stays open for the next one.
											event.preventDefault();
											toggle(filter);
										}}
									>
										{FILTERS[filter].label}
									</MenuItem>
								))}
								<MenuSeparator />
								<MenuSub>
									<MenuSubTrigger hint={SORTS[sort].label}>Sort</MenuSubTrigger>
									<MenuSubContent>
										{(Object.keys(SORTS) as Sort[]).map((entry) => (
											<MenuItem key={entry} checked={sort === entry} onSelect={() => setSort(entry)}>
												{SORTS[entry].label}
											</MenuItem>
										))}
									</MenuSubContent>
								</MenuSub>
							</MenuContent>
						</Menu>
					</div>

					<div ref={list} role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
						{/* One line for every plan not signed in to, so they do not push the models off a phone's screen. */}
						{unconnected.length ? (
							<p className="m-0 mx-1 mt-1.5 flex items-start gap-2 px-1 py-1 text-micro leading-[15px] text-(--text-3)">
								<span className="mt-[4.5px] size-1.5 shrink-0 rounded-full border border-(--track)" />
								<span>
									{new Intl.ListFormat('en', { type: 'conjunction' }).format(unconnected.map((entry) => entry.name))} {unconnected.length === 1 ? 'is' : 'are'} not
									connected. Sign in under Settings › Subscriptions.
								</span>
							</p>
						) : null}
						{models.isPending ? (
							<div className="flex h-16 items-center justify-center gap-2 text-small text-(--text-3)">
								<Spinner size={12} />
								Loading models
							</div>
						) : models.isError ? (
							<div className="px-2 py-4 text-small text-(--bad)">Could not load models: {models.error.message}</div>
						) : flat.length === 0 ? (
							unconnected.length ? null : <EmptyLine className="px-2 py-6 text-center">No models match.</EmptyLine>
						) : (
							sections.map((section) => {
								const start = offset;
								offset += section.models.length;
								const priced = section.models.some((model) => !model.subscription);
								return (
									<div key={section.title} role="group" aria-label={section.title} className="flex flex-col">
										<div className={cn(COLUMNS, 'sticky-veil sticky top-0 z-[1] pt-2.5 pb-1 shadow-[0_1px_0_var(--line)]')}>
											<span className="col-span-2 flex min-w-0 items-center gap-1.5">
												{section.plan ? <StatusDot tone="accent" /> : null}
												<span className={cn('in-caption truncate', section.plan && 'text-(--accent-text)')}>{section.title}</span>
												<span className="in-num text-nano text-(--text-4)">{section.total}</span>
											</span>
											{priced ? null : <span className="col-span-2" />}
											<span className="in-caption text-right" title="Context window, in tokens">
												Ctx
											</span>
											{priced ? (
												<>
													<span className="in-caption text-right" title="US dollars per million input tokens">
														In
													</span>
													<span className="in-caption text-right" title="US dollars per million output tokens">
														Out
													</span>
												</>
											) : null}
											<span />
										</div>
										{section.models.slice(0, Math.max(0, drawn - start)).map((model, index) => (
											<ModelRow
												key={`${section.title}-${model.id}`}
												model={model}
												index={start + index}
												selected={model.id === shown?.id}
												active={start + index === cursor}
												pinned={pinnedIds.includes(model.id)}
												priced={priced}
												onPick={onPickRow}
												onHover={setCursor}
												onPin={onPinRow}
												// The routing menus show on the row under the pointer or the keys, and on the chosen one.
												routing={!model.subscription && routable(model.id) && (start + index === cursor || model.id === shown?.id) ? routingFor(model) : undefined}
											/>
										))}
									</div>
								);
							})
						)}
					</div>

					<div className="flex shrink-0 flex-col border-t border-(--line)">
						{options && (options.contexts.length > 1 || options.fast) ? (
							<ModelOptionsRow options={options} note={selected !== options.base ? selected?.description : undefined} onChange={choose} />
						) : null}
						{effort ? <div className="flex items-center gap-3 py-1.5 pr-2 pl-3">
							<span className="in-caption w-12 shrink-0">Effort</span>
							<EffortTrack model={selected} value={reasoning} onChange={(level) => onChange({ reasoning: level })} />
						</div> : null}
					</div>
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
});
