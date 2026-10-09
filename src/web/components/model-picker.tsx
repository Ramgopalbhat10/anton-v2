import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Pin, Search, SlidersHorizontal } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { type KeyboardEvent, type PointerEvent, useMemo, useRef, useState } from 'react';
import { Count } from '@/components/instrument';
import { Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger, Spinner } from '@/components/signal';
import { api, type ModelChoice, type ModelInfo, type Reasoning, REASONING_LEVELS } from '@/lib/api';
import {
	dollars,
	effectiveReasoning,
	type Filter,
	FILTERS,
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
import { logoFor } from '@/lib/provider-logos';
import { cn } from '@/lib/utils';

/** Rendering every match would be slow; search narrows the rest. */
const LIMIT = 60;

/** Every source at once. */
const ALL = 'All';

export function useModels() {
	return useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 10 * 60_000 });
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
			className="relative inline-flex shrink-0 items-center justify-center rounded-[4px] font-mono font-semibold uppercase"
			style={
				logo
					? { width: size, height: size, fontSize: Math.round(size * 0.72), background: 'var(--alpha-white-6)', boxShadow: 'inset 0 0 0 1px var(--border-subtle)' }
					: { width: size, height: size, fontSize: size * 0.45, color: hue, background: `${hue}1f`, boxShadow: `inset 0 0 0 1px ${hue}33` }
			}
		>
			{logo ? (
				// The set's own files, sized by font size and drawn in the text colour where they have one colour.
				<span className="flex text-(--text-primary)" dangerouslySetInnerHTML={{ __html: logo }} />
			) : (
				model.vendor.replace(/[^a-z0-9]/gi, '').slice(0, 2)
			)}
			{model.subscription ? <span className="absolute -top-[2px] -right-[2px] size-[6px] rounded-full bg-(--accent-base) shadow-[0_0_0_1.5px_var(--bg-overlay)]" /> : null}
		</span>
	);
}

/** Rising bars: how hard the model reasons, on its own scale. */
function ReasoningMeter({ strength, className }: { strength: number; className?: string }) {
	return (
		<span aria-hidden className={cn('inline-flex h-2.5 items-end gap-px', className)}>
			{[0.25, 0.5, 0.75, 1].map((step) => (
				<span
					key={step}
					className={cn('w-[2px] rounded-full', strength >= step ? 'bg-(--accent-base)' : 'bg-(--alpha-white-14)')}
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
						className="w-[3px] rounded-[1px]"
						style={{
							height: `${25 + (index / (scale.length - 1)) * 75}%`,
							background: level === preferred ? 'var(--accent-base)' : levels.includes(level) ? 'var(--text-tertiary)' : 'var(--segment-off)',
						}}
					/>
				))}
			</span>
			<span className="in-num text-[11px] whitespace-nowrap text-(--text-tertiary)">
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
const COLUMNS = 'grid grid-cols-[16px_minmax(0,1fr)_32px_40px_40px_12px] items-center gap-x-2 px-2';

/** What a million tokens cost, in and out, in their own columns; a plan's or a free model's fills both with one word. */
function PriceCells({ model }: { model: ModelInfo }) {
	const word = model.subscription ? 'PLAN' : model.price.input === 0 && model.price.output === 0 ? 'FREE' : null;
	if (word) {
		return (
			<span className={cn('col-span-2 text-right font-mono text-[9.5px] tracking-[0.06em]', word === 'PLAN' ? 'text-(--accent-text)' : 'text-(--success-text)')}>
				{word}
			</span>
		);
	}
	return (
		<>
			<span className="in-num text-right text-[10.5px] text-(--text-tertiary)">{dollars(model.price.input)}</span>
			<span className="in-num text-right text-[10.5px] text-(--text-secondary)">{dollars(model.price.output)}</span>
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
 * pin shows on hover, and stays lit on a pinned model.
 */
function ModelRow({
	model,
	selected,
	active,
	pinned,
	onPick,
	onHover,
	onPin,
}: {
	model: ModelInfo;
	selected: boolean;
	active: boolean;
	pinned: boolean;
	onPick: () => void;
	onHover: () => void;
	onPin: () => void;
}) {
	return (
		// The list's keys pick the active row (see ModelPicker), so the row itself takes no focus; its pin does.
		<div
			role="option"
			aria-selected={selected}
			data-active={active || undefined}
			onClick={onPick}
			onMouseMove={onHover}
			title={about(model)}
			className={cn(COLUMNS, 'group/row h-8 w-full cursor-default rounded-[7px] text-left outline-none data-active:bg-(--bg-hover)')}
		>
			<ModelMark model={model} />
			<span className="flex min-w-0 items-center gap-1">
				<span className={cn('min-w-0 truncate text-[12.5px]', selected ? 'text-(--accent-text)' : 'text-(--text-primary)')}>{shortName(model)}</span>
				<button
					type="button"
					aria-label={`${pinned ? 'Unpin' : 'Pin'} ${model.name}`}
					aria-pressed={pinned}
					title={pinned ? 'Unpin' : 'Pin to the top'}
					onClick={(event) => {
						event.stopPropagation();
						onPin();
					}}
					className={cn(
						'inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] outline-none transition-opacity duration-(--duration-micro) hover:bg-(--alpha-white-6) focus-visible:opacity-100 focus-visible:shadow-(--focus-ring)',
						pinned ? 'text-(--accent-text) opacity-100' : 'text-(--icon-tertiary) opacity-0 group-hover/row:opacity-100 group-data-active/row:opacity-100',
					)}
				>
					<Icon icon={Pin} size={11} className={cn('rotate-45', pinned && '[&_path]:fill-current')} />
				</button>
			</span>
			<span className="in-num text-right text-[10.5px] text-(--text-disabled)">{tokens(model.contextLength)}</span>
			<PriceCells model={model} />
			<span className="flex justify-end text-(--accent-text)">{selected ? <Icon icon={Check} size={12} /> : null}</span>
		</div>
	);
}

/**
 * The model's efforts as a row of labels over a thin track that fills up to
 * the chosen one. Click a level, drag along the row, or use the arrow keys.
 */
export function EffortTrack({ model, value, onChange }: { model?: ModelInfo; value: Reasoning; onChange: (level: Reasoning) => void }) {
	const row = useRef<HTMLDivElement>(null);
	if (!model?.reasoning.length) return <span className="text-[11px] text-(--text-disabled)">No reasoning step</span>;
	const levels = model.reasoning;
	const chosen = Math.max(0, levels.indexOf(value));
	const centre = (index: number) => ((index + 0.5) / levels.length) * 100;

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

	return (
		<div
			ref={row}
			role="radiogroup"
			aria-label="Reasoning effort"
			onKeyDown={onKeyDown}
			onPointerDown={onPointer}
			onPointerMove={onPointer}
			className="relative grid min-w-0 flex-1 touch-none pb-1.5"
			style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}
		>
			{levels.map((level, index) => (
				<button
					type="button"
					role="radio"
					aria-checked={index === chosen}
					tabIndex={index === chosen ? 0 : -1}
					key={level}
					onClick={() => onChange(level)}
					title={level === model.defaultReasoning ? "The model's default" : undefined}
					className={cn(
						'h-6 min-w-0 truncate rounded-[5px] font-mono text-[10px] tracking-[0.04em] uppercase outline-none transition-colors duration-(--duration-micro) focus-visible:shadow-(--focus-ring)',
						index === chosen ? 'text-(--text-primary)' : 'text-(--text-disabled) hover:text-(--text-secondary)',
					)}
				>
					{REASONING_LABEL[level]}
				</button>
			))}
			<span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-(--segment-off)" />
			<span
				aria-hidden
				className="pointer-events-none absolute bottom-0 left-0 h-[2px] rounded-full bg-(--accent-base) transition-[width] duration-(--duration-micro)"
				style={{ width: `${centre(chosen)}%` }}
			/>
			<span
				aria-hidden
				className="pointer-events-none absolute bottom-[-2px] size-1.5 -translate-x-1/2 rounded-full bg-(--accent-base) shadow-[0_0_0_3px_var(--accent-bg-subtle)] transition-[left] duration-(--duration-micro)"
				style={{ left: `${centre(chosen)}%` }}
			/>
			{levels.includes(model.defaultReasoning) && model.defaultReasoning !== value ? (
				<span
					aria-hidden
					className="pointer-events-none absolute bottom-[-1px] size-1 -translate-x-1/2 rounded-full bg-(--text-disabled)"
					style={{ left: `${centre(levels.indexOf(model.defaultReasoning))}%` }}
				/>
			) : null}
		</div>
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

/**
 * Compact model chooser: a search, the models in one list with each source
 * (a plan you signed in to, or a gateway) as a section, and the chosen
 * model's effort along the bottom. Source, filters and sort sit in one menu.
 * Picking a model keeps the panel open so its effort can be set; Enter picks
 * and closes.
 */
export function ModelPicker({
	value,
	onChange,
	side = 'top',
	height = 26,
}: {
	value: ModelChoice;
	onChange: (change: Partial<ModelChoice>) => void;
	side?: 'top' | 'bottom';
	height?: 26 | 28;
}) {
	const models = useModels();
	const [open, setOpen] = useState(false);
	// A plan you could connect is listed in the menu, and named above the list, before it has models.
	const plans = useQuery({ queryKey: ['subscriptions'], queryFn: () => api.subscriptions(), enabled: open, staleTime: 60_000 });
	const [query, setQuery] = useState('');
	const [filters, setFilters] = useState<Set<Filter>>(() => new Set());
	const [sort, setSort] = useState<Sort>('newest');
	const [source, setSource] = useState(ALL);
	const [cursor, setCursor] = useState(0);
	const list = useRef<HTMLDivElement>(null);

	const all = models.data?.models ?? [];
	const selected = all.find((model) => model.id === value.model);
	const reasoning = effectiveReasoning(selected, value.reasoning);
	const sources = useMemo(
		() => sourcesOf(all, (plans.data?.subscriptions ?? []).map((plan) => ({ name: plan.name, connected: plan.state === 'connected' }))),
		[all, plans.data],
	);
	const unconnected = sources.filter((entry) => entry.plan && !entry.connected && (source === ALL || source === entry.name));
	const inSource = useMemo(() => (source === ALL ? all : all.filter((model) => sourceOf(model) === source)), [all, source]);
	const browsing = !query && filters.size === 0;
	const matching = useMemo(() => visibleModels(inSource, query, filters, sort), [inSource, query, filters, sort]);
	const pinnedIds = useMemo(() => models.data?.pinned ?? [], [models.data]);
	const sections = useMemo(() => sectionsFor(all, matching, browsing, source, pinnedIds), [all, matching, browsing, source, pinnedIds]);
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
		if (model.id !== value.model) onChange({ model: model.id, reasoning: null });
		if (close) setOpen(false);
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
		// The menu, the effort row and a focused pin answer their own keys.
		if (!handler || (event.target as HTMLElement).closest('[role=menu],[role=radiogroup],[aria-pressed]')) return;
		event.preventDefault();
		handler();
		requestAnimationFrame(() => list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' }));
	}

	let offset = 0;

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
						'flex max-w-[260px] min-w-0 shrink items-center gap-1.5 rounded-lg bg-(--bg-overlay) pr-1.5 pl-1 whitespace-nowrap text-(--text-secondary) transition-colors duration-(--duration-micro) outline-none hover:bg-(--neutral-700) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)',
						height === 28 ? 'h-7' : 'h-[26px]',
					)}
				>
					{selected ? <ModelMark model={selected} size={height - 10} /> : <Spinner size={12} tone="neutral" />}
					<span className="min-w-0 truncate text-[12px]">{selected ? shortName(selected) : 'Model'}</span>
					{selected?.subscription ? <span className="font-mono text-[9.5px] tracking-[0.06em] text-(--accent-text)">PLAN</span> : null}
					{selected?.reasoning.length ? (
						<span className="flex items-center gap-1 rounded-[4px] bg-(--alpha-white-6) px-1 py-px" title={`Reasoning effort: ${REASONING_LABEL[reasoning]}`}>
							<ReasoningMeter strength={reasoningStrength(selected, reasoning)} />
							<span className="text-[10px] text-(--text-tertiary)">{REASONING_LABEL[reasoning]}</span>
						</span>
					) : null}
					<Icon icon={ChevronDown} size={12} className="text-(--icon-tertiary)" />
				</button>
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					side={side}
					align="start"
					sideOffset={6}
					collisionPadding={12}
					onKeyDown={onKeyDown}
					className="z-50 flex h-[min(440px,var(--radix-popover-content-available-height))] min-h-[240px] w-[min(380px,calc(100vw-24px))] in-pop flex-col overflow-hidden text-(--text-primary) outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
				>
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-(--border-subtle) pr-1.5 pl-3">
						<Icon icon={Search} size={13} className="text-(--icon-tertiary)" />
						<input
							autoFocus
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setCursor(0);
							}}
							placeholder="Search models"
							aria-label="Search models"
							className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-placeholder)"
						/>
						{models.isPending ? null : <Count>{browsing ? inSource.length : `${matching.length}/${inSource.length}`}</Count>}
						<Menu>
							<MenuTrigger asChild>
								<button
									type="button"
									aria-label="Source, filters and sort"
									className={cn(
										'relative inline-flex size-7 shrink-0 items-center justify-center rounded-[7px] text-(--icon-tertiary) outline-none hover:bg-(--bg-hover) hover:text-(--icon-secondary) focus-visible:shadow-(--focus-ring) data-[state=open]:bg-(--bg-hover)',
										narrowed && 'text-(--accent-text)',
									)}
								>
									<Icon icon={SlidersHorizontal} size={13} />
									{narrowed ? <span className="absolute top-1 right-1 size-1.5 rounded-full bg-(--accent-base)" /> : null}
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
						{unconnected.map((entry) => (
							<p key={entry.name} className="m-0 mx-1 mt-1.5 flex items-center gap-2 px-1 py-1 text-[11px] text-(--text-tertiary)">
								<span className="size-1.5 shrink-0 rounded-full border border-(--neutral-600)" />
								{entry.name} is not connected. Sign in under Settings › Subscriptions.
							</p>
						))}
						{models.isPending ? (
							<div className="flex h-16 items-center justify-center gap-2 text-[12px] text-(--text-tertiary)">
								<Spinner size={12} />
								Loading models
							</div>
						) : models.isError ? (
							<div className="px-2 py-4 text-[12px] text-(--danger-text)">Could not load models: {models.error.message}</div>
						) : flat.length === 0 ? (
							unconnected.length ? null : <div className="px-2 py-6 text-center text-[12px] text-(--text-tertiary)">No models match.</div>
						) : (
							sections.map((section) => {
								const start = offset;
								offset += section.models.length;
								return (
									<div key={section.title} role="group" aria-label={section.title} className="flex flex-col">
										<div className={cn(COLUMNS, 'sticky top-0 z-[1] bg-(--pop-bg) pt-2.5 pb-1')}>
											<span className="col-span-2 flex min-w-0 items-center gap-1.5">
												{section.plan ? <span className="size-1.5 shrink-0 rounded-full bg-(--accent-base)" /> : null}
												<span className={cn('in-caption truncate', section.plan && 'text-(--accent-text)')}>{section.title}</span>
												<span className="in-num text-[10px] text-(--text-disabled)">{section.total}</span>
											</span>
											<span className="in-caption text-right" title="Context window, in tokens">
												Ctx
											</span>
											{section.models.some((model) => !model.subscription) ? (
												<>
													<span className="in-caption text-right" title="US dollars per million input tokens">
														In
													</span>
													<span className="in-caption text-right" title="US dollars per million output tokens">
														Out
													</span>
												</>
											) : (
												<span className="col-span-2" />
											)}
											<span />
										</div>
										{section.models.map((model, index) => (
											<ModelRow
												key={`${section.title}-${model.id}`}
												model={model}
												selected={model.id === value.model}
												active={start + index === cursor}
												pinned={pinnedIds.includes(model.id)}
												onPick={() => pick(model, false)}
												onHover={() => setCursor(start + index)}
												onPin={() => togglePin(model)}
											/>
										))}
									</div>
								);
							})
						)}
					</div>

					<div className="flex h-11 shrink-0 items-center gap-3 border-t border-(--border-subtle) px-3">
						<span className="in-caption shrink-0">Effort</span>
						<EffortTrack model={selected} value={reasoning} onChange={(level) => onChange({ reasoning: level })} />
					</div>
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}
