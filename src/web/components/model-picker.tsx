import { useQuery } from '@tanstack/react-query';
import { ArrowDownUp, Brain, Check, ChevronDown, Eye, Search } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { FilterChip, Icon, Spinner } from '@/components/signal';
import { api, type ModelChoice, type ModelInfo, type Reasoning } from '@/lib/api';
import {
	costTier,
	dollars,
	effectiveReasoning,
	type Filter,
	FILTERS,
	NEXT_SORT,
	REASONING_LABEL,
	reasoningStrength,
	recentModels,
	rememberModel,
	shortName,
	type Sort,
	SORTS,
	tokens,
	vendorHue,
	visibleModels,
} from '@/lib/model-catalog';
import { cn } from '@/lib/utils';

/** Rendering every match would be slow; search narrows the rest. */
const LIMIT = 60;

export function useModels() {
	return useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 10 * 60_000 });
}

/** Two-letter vendor tile in the vendor's hue. */
function VendorMark({ vendor, size = 18 }: { vendor: string; size?: number }) {
	const hue = vendorHue(vendor);
	return (
		<span
			aria-hidden
			className="inline-flex shrink-0 items-center justify-center rounded-[5px] font-mono font-semibold uppercase"
			style={{ width: size, height: size, fontSize: size * 0.45, color: hue, background: `${hue}1f`, boxShadow: `inset 0 0 0 1px ${hue}33` }}
		>
			{vendor.replace(/[^a-z0-9]/gi, '').slice(0, 2)}
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

/** Four dots, lit by output price tier. */
function CostDots({ model }: { model: ModelInfo }) {
	const tier = costTier(model);
	return (
		<span className="inline-flex items-center gap-[2px]" title={`${dollars(model.price.input)} in · ${dollars(model.price.output)} out per 1M tokens`}>
			{tier === 0 ? (
				<span className="font-mono text-[10px] text-(--success-text)">FREE</span>
			) : (
				[1, 2, 3, 4].map((step) => (
					<span key={step} className={cn('size-[3px] rounded-full', tier >= step ? 'bg-(--warning-base)' : 'bg-(--alpha-white-14)')} />
				))
			)}
		</span>
	);
}

function ModelRow({
	model,
	selected,
	active,
	onPick,
	onHover,
}: {
	model: ModelInfo;
	selected: boolean;
	active: boolean;
	onPick: () => void;
	onHover: () => void;
}) {
	return (
		<button
			type="button"
			role="option"
			aria-selected={selected}
			data-active={active || undefined}
			onClick={onPick}
			onMouseMove={onHover}
			title={model.description}
			className="group flex h-9 w-full items-center gap-2 rounded-md px-2 text-left outline-none data-active:bg-(--bg-hover)"
		>
			<VendorMark vendor={model.vendor} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className={cn('truncate text-[12.5px] leading-4', selected ? 'text-(--accent-text)' : 'text-(--text-primary)')}>
					{shortName(model)}
				</span>
				<span className="truncate text-[10.5px] leading-3.5 text-(--text-disabled)">{model.vendor}</span>
			</span>
			<span className="flex shrink-0 items-center gap-1.5 text-(--icon-tertiary)">
				{model.reasoning.length ? <Icon icon={Brain} size={11} /> : null}
				{model.vision ? <Icon icon={Eye} size={11} /> : null}
			</span>
			<span className="w-9 shrink-0 text-right font-mono text-[10.5px] text-(--text-tertiary)">{tokens(model.contextLength)}</span>
			<span className="flex w-8 shrink-0 justify-end">
				<CostDots model={model} />
			</span>
			<span className="flex w-3 shrink-0 justify-end text-(--accent-text)">{selected ? <Icon icon={Check} size={12} /> : null}</span>
		</button>
	);
}

/** Segmented control over the levels this model accepts. */
function ReasoningControl({ model, value, onChange }: { model?: ModelInfo; value: Reasoning; onChange: (level: Reasoning) => void }) {
	if (!model?.reasoning.length) {
		return <span className="text-[11px] text-(--text-disabled)">This model answers without a reasoning step.</span>;
	}
	return (
		<div role="radiogroup" aria-label="Reasoning" className="flex min-w-0 flex-1 rounded-md bg-(--bg-inset) p-0.5">
			{model.reasoning.map((level) => (
				<button
					type="button"
					role="radio"
					aria-checked={level === value}
					key={level}
					onClick={() => onChange(level)}
					className={cn(
						'h-[22px] min-w-0 flex-1 rounded-[4px] px-1.5 text-[11px] whitespace-nowrap transition-colors duration-(--duration-micro) outline-none focus-visible:shadow-(--focus-ring)',
						level === value ? 'bg-(--bg-overlay) text-(--text-primary) shadow-(--shadow-inset-hairline)' : 'text-(--text-tertiary) hover:text-(--text-secondary)',
					)}
				>
					{REASONING_LABEL[level]}
					{level === model.defaultReasoning ? (
						<span className="ml-0.5 text-(--text-disabled)" title="The model's default">
							·
						</span>
					) : null}
				</button>
			))}
		</div>
	);
}

function Details({ model }: { model?: ModelInfo }) {
	if (!model) return null;
	const facts = [
		`${tokens(model.contextLength)} context`,
		model.maxOutput ? `${tokens(model.maxOutput)} out` : null,
		`${dollars(model.price.input)} / ${dollars(model.price.output)} per 1M`,
	].filter(Boolean);
	return (
		<div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-(--text-tertiary)">
			<span className="truncate text-(--text-secondary)">{model.name}</span>
			<span className="shrink-0 font-mono">{facts.join(' · ')}</span>
		</div>
	);
}

type Section = { title: string; models: ModelInfo[] };

function sectionsFor(models: ModelInfo[], visible: ModelInfo[], browsing: boolean): Section[] {
	const recent = browsing
		? recentModels()
				.map((id) => models.find((model) => model.id === id))
				.filter((model) => model !== undefined)
		: [];
	const rest = visible.filter((model) => !recent.includes(model)).slice(0, LIMIT);
	return [
		{ title: 'Recent', models: recent },
		{ title: browsing ? 'All models' : `${visible.length} matches`, models: rest },
	].filter((section) => section.models.length > 0);
}

/**
 * Compact model chooser over the gateway's live catalog: search, capability
 * filters, sort, and the reasoning level for the chosen model. Picking a
 * model keeps the panel open so its reasoning can be set; Enter picks and
 * closes.
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
	const [query, setQuery] = useState('');
	const [filters, setFilters] = useState<Set<Filter>>(() => new Set());
	const [sort, setSort] = useState<Sort>('newest');
	const [cursor, setCursor] = useState(0);
	const list = useRef<HTMLDivElement>(null);

	const all = models.data?.models ?? [];
	const selected = all.find((model) => model.id === value.model);
	const reasoning = effectiveReasoning(selected, value.reasoning);
	const browsing = !query && filters.size === 0;
	const sections = useMemo(
		() => sectionsFor(all, visibleModels(all, query, filters, sort), browsing),
		[all, query, filters, sort, browsing],
	);
	const flat = sections.flatMap((section) => section.models);
	const active = flat[Math.min(cursor, flat.length - 1)];

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
		if (!handler) return;
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
					className={cn(
						'flex max-w-[240px] min-w-0 shrink items-center gap-1.5 rounded-lg bg-(--bg-overlay) pr-1.5 pl-1 whitespace-nowrap text-(--text-secondary) transition-colors duration-(--duration-micro) outline-none hover:bg-(--neutral-700) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)',
						height === 28 ? 'h-7' : 'h-[26px]',
					)}
				>
					{selected ? <VendorMark vendor={selected.vendor} size={height - 10} /> : <Spinner size={12} tone="neutral" />}
					<span className="min-w-0 truncate text-[12px]">{selected ? shortName(selected) : 'Model'}</span>
					{selected?.reasoning.length ? (
						<span className="flex items-center gap-1 rounded-[4px] bg-(--alpha-white-6) px-1 py-px" title={`Reasoning: ${REASONING_LABEL[reasoning]}`}>
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
					className="z-50 flex max-h-[min(460px,var(--radix-popover-content-available-height))] w-[min(400px,calc(100vw-24px))] in-pop flex-col overflow-hidden text-(--text-primary) outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
				>
					<div className="flex flex-col gap-2 px-2.5 pt-2.5 pb-2">
						<div className="flex h-8 items-center gap-2 rounded-lg bg-(--bg-inset) px-2.5">
							<Icon icon={Search} size={13} className="text-(--icon-tertiary)" />
							<input
								autoFocus
								value={query}
								onChange={(event) => {
									setQuery(event.target.value);
									setCursor(0);
								}}
								placeholder="Search models, vendors…"
								aria-label="Search models"
								className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-placeholder)"
							/>
							<span className="font-mono text-[10.5px] text-(--text-disabled)">{models.isPending ? '' : all.length}</span>
						</div>
						<div data-noscrollbar className="flex items-center gap-1 overflow-x-auto">
							{(Object.keys(FILTERS) as Filter[]).map((filter) => (
								<FilterChip key={filter} label={FILTERS[filter].label} on={filters.has(filter)} onToggle={() => toggle(filter)} />
							))}
							<div className="min-w-1 flex-1" />
							<button
								type="button"
								onClick={() => setSort(NEXT_SORT[sort])}
								title="Change the sort order"
								className="flex h-[22px] shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] text-(--text-tertiary) outline-none hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring)"
							>
								<Icon icon={ArrowDownUp} size={11} />
								{SORTS[sort].label}
							</button>
						</div>
					</div>

					<div ref={list} role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
						{models.isPending ? (
							<div className="flex h-16 items-center justify-center gap-2 text-[12px] text-(--text-tertiary)">
								<Spinner size={12} />
								Loading models
							</div>
						) : models.isError ? (
							<div className="px-2 py-4 text-[12px] text-(--danger-text)">Could not load models: {models.error.message}</div>
						) : flat.length === 0 ? (
							<div className="px-2 py-6 text-center text-[12px] text-(--text-tertiary)">No models match.</div>
						) : (
							sections.map((section) => {
								const start = offset;
								offset += section.models.length;
								return (
									<div key={section.title} className="flex flex-col">
										<div className="px-2 pt-1.5 pb-1 text-[10px] tracking-[0.06em] text-(--text-disabled) uppercase">{section.title}</div>
										{section.models.map((model, index) => (
											<ModelRow
												key={`${section.title}-${model.id}`}
												model={model}
												selected={model.id === value.model}
												active={start + index === cursor}
												onPick={() => pick(model, false)}
												onHover={() => setCursor(start + index)}
											/>
										))}
									</div>
								);
							})
						)}
					</div>

					<div className="flex flex-col gap-1.5 bg-(--bg-raised) px-2.5 py-2">
						<Details model={selected} />
						<div className="flex items-center gap-2">
							<span className="flex shrink-0 items-center gap-1 text-[11px] text-(--text-tertiary)">
								<Icon icon={Brain} size={12} />
								Reasoning
							</span>
							<ReasoningControl model={selected} value={reasoning} onChange={(level) => onChange({ reasoning: level })} />
						</div>
					</div>
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}
