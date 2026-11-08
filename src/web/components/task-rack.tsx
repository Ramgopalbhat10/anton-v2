import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUp, ArrowUpRight, ChevronLeft, ChevronRight, GitFork, GitPullRequest, LayoutGrid, Square } from 'lucide-react';
import { type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Card, CardSection } from '@/components/instrument';
import { Btn, Icon, IconBtn } from '@/components/signal';
import { useFork } from '@/components/task-actions';
import { isLive, liveLabel } from '@/components/task-status';
import { api, branchLabel, repoShort, type Session } from '@/lib/api';
import { age, dollars, tokens } from '@/lib/format';
import { useModels } from '@/components/model-picker';
import { setPendingPrompt } from '@/lib/pending-prompt';

/* Items in a row of bays, drawn flat on the pixel grid: each bay a tray of
   slots, each item a tile standing in its slot with a light that shows how it
   stands. Pointing at a tile (or tabbing to it) lifts it and opens a card with
   its details and what can be done with it. The card stays while the pointer is
   on it. The row is as long as it needs to be and scrolls sideways, or by the
   header's arrows.

   `RackWell` draws any bays of items; the Tasks page fills it with every task,
   ten to a bay (`RackCard`), and Projects with one bay per project and its
   threads as the tiles (`project-rack.tsx`). */

/** Tiles in one bay. */
export const PER_BAY = 10;
/** How wide each bay's share of the row is, so bays keep one size however many there are. */
const BAY_PX = 236;
/** How long the card waits after the pointer leaves its tile or itself, so it can be reached. */
const LINGER_MS = 320;

type Kind = 'live' | 'pr' | 'failed' | 'stopped';

/** The same four states, in the same colours, as the split bar under the rack, which is the legend. */
const KINDS: Record<Kind, { label: string; color: string }> = {
	live: { label: 'Running', color: 'var(--accent-base)' },
	pr: { label: 'Pull request', color: 'var(--data-2)' },
	stopped: { label: 'Stopped', color: 'var(--neutral-500)' },
	failed: { label: 'Failed', color: 'var(--danger-base)' },
};

const kindOf = (session: Session): Kind => (isLive(session) ? 'live' : session.status === 'error' ? 'failed' : session.prUrl ? 'pr' : 'stopped');

function stateWord(session: Session): string {
	const kind = kindOf(session);
	if (kind === 'live') return liveLabel(session);
	if (kind === 'pr') return session.pullRequest ? `PR ${session.pullRequest.state}` : 'PR opened';
	return KINDS[kind].label;
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How a tile shows its item: the colour of its light, whether it works (its light runs) or calls for you (its light pulses), and its name for assistive tech. */
export type RackLook = { color: string; live: boolean; label: string; alert?: boolean };

type Handlers = { onOpen: () => void; onClose: () => void; onChoose: () => void };

/** One tile: a slim upright card in its slot, its light at the foot. */
function Tile({ look, slot, open, handlers, tileRef }: { look: RackLook; slot: number; open: boolean; handlers: Handlers; tileRef: (element: HTMLDivElement | null) => void }) {
	return (
		<div
			ref={tileRef}
			role="link"
			tabIndex={0}
			aria-label={look.label}
			data-open={open || undefined}
			data-live={look.live || undefined}
			className="rack-blade"
			style={{ '--slot': slot, '--light': look.color } as CSSProperties}
			onPointerEnter={handlers.onOpen}
			onPointerLeave={handlers.onClose}
			onFocus={handlers.onOpen}
			onBlur={handlers.onClose}
			onClick={handlers.onChoose}
			onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					handlers.onChoose();
				}
			}}
		>
			<span aria-hidden className="rack-blade__lines" />
			{look.live ? <span aria-hidden className="rack-blade__run" /> : null}
			<span aria-hidden className={look.live || look.alert ? 'rack-blade__light in-pulse' : 'rack-blade__light'} />
		</div>
	);
}

export type Linger = { onPointerEnter: () => void; onPointerLeave: () => void; onFocus: () => void; onBlur: (event: FocusEvent<HTMLDivElement>) => void; onDismiss: () => void };

/** Where the open blade's card sits in the well: beside the blade, on the side with more room, or under the drawing when neither side has room. */
export type Placement = { side: 'left' | 'right'; from: [number, number]; edge: number } | { side: 'below' };

const CARD_W = 300;
const GAP = 22;

/**
 * The open blade's card: beside the blade with a dashed leader from the blade
 * to it, outside the scrolling row so the row cannot clip it, and the gap
 * between them bridged so the pointer can cross from the blade to the card.
 * In a narrow well it sits under the drawing instead.
 */
export function RackPopover({ label, placement, linger, children }: { label: string; placement: Placement; linger: Linger; children: ReactNode }) {
	const events = {
		onPointerEnter: linger.onPointerEnter,
		onPointerLeave: linger.onPointerLeave,
		onFocus: linger.onFocus,
		onBlur: linger.onBlur,
		onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
			if (event.key === 'Escape') linger.onDismiss();
		},
	};
	if (placement.side === 'below') {
		return (
			<div role="dialog" aria-label={label} className="rack-card in-pop relative z-10 mx-3 mt-1 flex flex-col text-left" {...events}>
				<span aria-hidden className="absolute inset-x-0 bottom-full h-6" />
				{children}
			</div>
		);
	}
	const { side, from, edge } = placement;
	const leader = side === 'right' ? { left: from[0], width: edge - from[0] } : { left: edge, width: from[0] - edge };
	return (
		<>
			<span aria-hidden className="rack-leader pointer-events-none absolute z-10 border-t border-dashed border-(--accent-base)" style={{ left: leader.left, top: from[1], width: leader.width }}>
				<span className="absolute -top-[3.5px] size-1.5 rounded-full bg-(--accent-base)" style={side === 'right' ? { left: -3 } : { right: -3 }} />
			</span>
			<div
				role="dialog"
				aria-label={label}
				className="rack-card in-pop absolute top-1/2 z-10 flex flex-col text-left"
				style={{ width: CARD_W, ...(side === 'right' ? { left: edge } : { left: edge - CARD_W }), transform: 'translateY(-50%)' }}
				{...events}
			>
				<span aria-hidden className="absolute inset-y-0" style={side === 'right' ? { right: '100%', width: GAP + 8 } : { left: '100%', width: GAP + 8 }} />
				{children}
			</div>
		</>
	);
}

/**
 * A task's card, and what can be done with it: send it a follow-up (the task
 * opens and sends it), fork it into a new task, stop it while it runs, go to
 * its pull request, or open it.
 */
function TaskDetails({ session }: { session: Session }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const fork = useFork(session);
	const stop = useMutation({ mutationFn: () => api.stopSession(session.id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }) });
	const [prompt, setPrompt] = useState('');
	const kind = kindOf(session);
	const model = session.model.split('/').pop() ?? session.model;
	// A plan model costs nothing per token; its calls count against the plan instead.
	const onPlan = Boolean(useModels().data?.models.find((entry) => entry.id === session.model)?.subscription);
	const stats: Array<[string, ReactNode]> = [
		[onPlan ? 'billed' : 'spent', onPlan ? 'plan' : dollars(session.usage.cost)],
		['tokens', tokens(session.usage.inputTokens + session.usage.outputTokens)],
		['model', model],
	];
	// The latest thing the task was asked; tasks from before Anton kept it show their first message, the title.
	const latest = session.lastInput?.trim() || session.title;
	const latestAt = session.lastInputAt ?? session.createdAt;
	const followedUp = Boolean(session.lastInput && session.lastInputAt && session.lastInputAt !== session.createdAt && session.lastInput !== session.title);
	const openTask = () => void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code' } });
	const send = () => {
		const text = prompt.trim();
		if (!text) return;
		setPendingPrompt(session.id, text);
		openTask();
	};
	return (
		<>
			<div className="flex flex-col gap-1.5 px-3.5 pt-3 pb-3">
				<div className="flex items-center gap-1.5">
					<span className={`size-1.5 shrink-0 rounded-full ${kind === 'live' ? 'in-pulse' : ''}`} style={{ background: KINDS[kind].color }} />
					<span className="in-caption text-(--text-secondary)">{stateWord(session)}</span>
					<span className="in-caption ml-auto" title={`Started ${new Date(session.createdAt).toLocaleString()}`}>
						started {age(session.createdAt)} ago
					</span>
				</div>
				<div className="truncate text-[12px] text-(--text-tertiary)" title={session.title}>
					{session.title}
				</div>
				<div className="flex flex-col gap-1 rounded-[6px] border border-(--border-subtle) bg-(--well-bg) px-2.5 py-2">
					<div className="flex items-center gap-1.5">
						<span className="in-caption">{followedUp ? 'Latest input' : 'Input'}</span>
						<span className="in-caption ml-auto tracking-normal normal-case" title={new Date(latestAt).toLocaleString()}>
							{age(latestAt)} ago
						</span>
					</div>
					<p className="m-0 line-clamp-3 text-[13px] leading-[18px] text-pretty whitespace-pre-line text-(--text-primary)">{latest}</p>
				</div>
				<div className="truncate font-mono text-[11px] text-(--text-tertiary)">
					{repoShort(session)} · {branchLabel(session)}
				</div>
			</div>
			<RackStats stats={stats} />
			<form
				className="flex flex-col gap-2 border-t border-(--border-subtle) p-2.5"
				onSubmit={(event) => {
					event.preventDefault();
					send();
				}}
			>
				<FollowUp value={prompt} onChange={setPrompt} label={`Send a follow-up to ${session.title}`} submitLabel="Send to this task" />
				<div className="flex items-center gap-1.5">
					<Btn size="sm" icon={GitFork} disabled={fork.isPending} onClick={() => fork.mutate()}>
						{fork.isPending ? 'Forking…' : 'Fork'}
					</Btn>
					{kind === 'live' ? (
						<Btn size="sm" icon={Square} disabled={stop.isPending} onClick={() => stop.mutate()}>
							{stop.isPending ? 'Stopping…' : 'Stop'}
						</Btn>
					) : session.prUrl ? (
						<a className="sg-btn sg-btn--secondary sg-btn--sm" href={session.prUrl} target="_blank" rel="noreferrer">
							<Icon icon={GitPullRequest} size={14} />
							PR
						</a>
					) : null}
					<Btn size="sm" variant="primary" className="ml-auto" onClick={openTask}>
						Open task
						<Icon icon={ArrowUpRight} size={14} />
					</Btn>
				</div>
			</form>
		</>
	);
}

/** A card's figures in a row of cells: value over its mono label. */
export function RackStats({ stats }: { stats: Array<[string, ReactNode]> }) {
	return (
		<div className="grid grid-cols-[auto_auto_minmax(0,1fr)] border-t border-(--border-subtle)">
			{stats.map(([label, value], i) => (
				<div key={label} className={`flex min-w-0 flex-col gap-0.5 px-3.5 py-2 ${i ? 'border-l border-(--border-subtle)' : ''}`}>
					<span className="truncate text-[12.5px] text-(--text-primary)">{value}</span>
					<span className="in-caption">{label}</span>
				</div>
			))}
		</div>
	);
}

/** The follow-up field in a card: a line to type in and a send button. */
export function FollowUp({ value, onChange, label, submitLabel, disabled }: { value: string; onChange: (value: string) => void; label: string; submitLabel: string; disabled?: boolean }) {
	return (
		<div className="flex h-9 items-center gap-2 rounded-[6px] border border-(--border-subtle) bg-(--well-bg) pr-1 pl-3 focus-within:border-(--accent-border)">
			<input
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder="Send a follow-up…"
				aria-label={label}
				className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12.5px] text-(--text-primary) outline-none placeholder:text-(--text-disabled)"
			/>
			<IconBtn icon={ArrowUp} label={submitLabel} size="xs" variant={value.trim() ? 'primary' : 'ghost'} type="submit" disabled={disabled || !value.trim()} />
		</div>
	);
}

/** The row's sideways scroll: which ends are in view, and a smooth step one way for the arrows. */
function useRowScroll() {
	const ref = useRef<HTMLDivElement>(null);
	const [edges, setEdges] = useState({ start: true, end: true });
	const measure = useCallback(() => {
		const element = ref.current;
		if (!element) return;
		setEdges({ start: element.scrollLeft <= 1, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1 });
	}, []);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [measure]);
	const step = (direction: 1 | -1) => ref.current?.scrollBy({ left: direction * ref.current.clientWidth * 0.8, behavior: reducedMotion() ? 'auto' : 'smooth' });
	return { ref, edges, measure, step };
}

/** One bay of a rack: its items as blades, whether its lid sweeps, its light, and a plate under it. */
export type RackBay<T> = { key: string; items: T[]; sweep?: boolean; led?: string; plate?: ReactNode };

export type RackWellHandle = { scrolls: boolean; edges: { start: boolean; end: boolean }; step: (direction: 1 | -1) => void };

/**
 * Bays of blades across a well, the row scrolling sideways when it is longer
 * than the well. Pointing at a blade draws it out and opens its card
 * (`details`); choosing it (click or Enter) runs `onChoose`. Plates, when
 * given, sit under their bays and scroll with them.
 */
export function RackWell<T extends { id: string }>({
	bays,
	look,
	details,
	detailsLabel,
	onChoose,
	label,
	onScrollState,
}: {
	bays: Array<RackBay<T>>;
	look: (item: T) => RackLook;
	details: (item: T) => ReactNode;
	detailsLabel: (item: T) => string;
	onChoose: (item: T) => void;
	label: string;
	onScrollState?: (state: RackWellHandle) => void;
}) {
	const scroll = useRowScroll();
	const well = useRef<HTMLDivElement>(null);
	const tiles = useRef(new Map<number, HTMLDivElement>());
	const [open, setOpen] = useState<number | null>(null);
	const [placement, setPlacement] = useState<Placement | null>(null);
	const closing = useRef(0);
	const scrolls = !(scroll.edges.start && scroll.edges.end);
	const itemAt = (index: number): T | undefined => bays[Math.floor(index / PER_BAY)]?.items[index % PER_BAY];

	useEffect(() => {
		onScrollState?.({ scrolls, edges: scroll.edges, step: scroll.step });
	}, [scrolls, scroll.edges.start, scroll.edges.end]);

	const hold = () => window.clearTimeout(closing.current);
	const letGo = () => {
		hold();
		closing.current = window.setTimeout(() => setOpen(null), LINGER_MS);
	};
	useEffect(() => hold, []);

	/** Where the open tile's card goes, measured from the tile as it sits now:
	    beside it, on whichever side has room, else under the row. */
	const place = useCallback((index: number) => {
		const tile = tiles.current.get(index);
		if (!well.current || !tile) return;
		const box = well.current.getBoundingClientRect();
		const rect = tile.getBoundingClientRect();
		const middle = rect.top - box.top + rect.height / 2;
		const right: [number, number] = [rect.right - box.left, middle];
		const left: [number, number] = [rect.left - box.left, middle];
		const fitsRight = right[0] + GAP + CARD_W <= box.width - 8;
		const fitsLeft = left[0] - GAP - CARD_W >= 8;
		setPlacement(fitsRight ? { side: 'right', from: right, edge: right[0] + GAP } : fitsLeft ? { side: 'left', from: left, edge: left[0] - GAP } : { side: 'below' });
	}, []);

	useEffect(() => {
		if (open !== null) place(open);
	}, [open, place]);

	const linger: Linger = {
		onPointerEnter: hold,
		// Typing in the card keeps it open even when the pointer wanders off.
		onPointerLeave: () => {
			if (!well.current?.querySelector('.rack-card')?.contains(document.activeElement)) letGo();
		},
		onFocus: hold,
		onBlur: (event) => {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) letGo();
		},
		onDismiss: () => {
			hold();
			setOpen(null);
		},
	};
	const fade = `linear-gradient(to right, ${scroll.edges.start ? '#000' : 'transparent'} 0, #000 40px, #000 calc(100% - 40px), ${scroll.edges.end ? '#000' : 'transparent'} 100%)`;
	const opened = open !== null ? itemAt(open) : undefined;

	return (
		<div ref={well} className="in-well in-grid relative py-4">
			<div
				ref={scroll.ref}
				className="rack-scroll overflow-x-auto overflow-y-hidden px-4 pt-2 pb-1"
				style={{ maskImage: fade, WebkitMaskImage: fade }}
				onScroll={() => {
					scroll.measure();
					// Keep the open card on its tile as the row moves under it.
					if (open !== null) place(open);
				}}
			>
				<div role="group" aria-label={label} className="mx-auto flex w-max items-start gap-3">
					{bays.map((bay, b) => {
						const items = bay.items.slice(0, PER_BAY);
						return (
							<div key={bay.key} className="flex flex-col items-center gap-2.5" style={{ width: BAY_PX }}>
								<div className="rack-bay" data-sweep={bay.sweep || undefined}>
									{bay.led ? <span aria-hidden className="rack-bay__led" style={{ background: bay.led }} /> : null}
									{Array.from({ length: PER_BAY }, (_, slot) => {
										const item = items[slot];
										const index = b * PER_BAY + slot;
										return item ? (
											<Tile
												key={item.id}
												look={look(item)}
												slot={slot}
												open={open === index}
												tileRef={(element) => {
													if (element) tiles.current.set(index, element);
													else tiles.current.delete(index);
												}}
												handlers={{
													onOpen: () => {
														hold();
														setOpen(index);
													},
													onClose: letGo,
													onChoose: () => onChoose(item),
												}}
											/>
										) : (
											<span key={`empty-${slot}`} aria-hidden className="rack-slot" />
										);
									})}
								</div>
								{bay.plate ? <div className="flex w-full min-w-0 justify-center px-2">{bay.plate}</div> : null}
							</div>
						);
					})}
				</div>
			</div>
			{opened && placement ? (
				<RackPopover key={opened.id} label={detailsLabel(opened)} placement={placement} linger={linger}>
					{details(opened)}
				</RackPopover>
			) : null}
		</div>
	);
}

/** The header's arrows for a rack that scrolls. */
export function RackArrows({ state, newer, older }: { state: RackWellHandle | null; newer: string; older: string }) {
	if (!state?.scrolls) return null;
	return (
		<>
			<IconBtn icon={ChevronLeft} label={newer} size="sm" disabled={state.edges.start} onClick={() => state.step(-1)} />
			<IconBtn icon={ChevronRight} label={older} size="sm" disabled={state.edges.end} onClick={() => state.step(1)} />
		</>
	);
}

const taskLook = (session: Session): RackLook => {
	const kind = kindOf(session);
	return { color: KINDS[kind].color, live: kind === 'live', label: `${session.title}, ${stateWord(session)}` };
};

/** Every task, newest first, as blades in a row of bays across the card; the row scrolls sideways when it is longer than the card. */
export function RackCard({ sessions }: { sessions: Session[] }) {
	const navigate = useNavigate();
	const [scroll, setScroll] = useState<RackWellHandle | null>(null);
	const bays: Array<RackBay<Session>> = Array.from({ length: Math.max(1, Math.ceil(sessions.length / PER_BAY)) }, (_, bay) => ({
		key: String(bay),
		items: sessions.slice(bay * PER_BAY, (bay + 1) * PER_BAY),
	}));
	return (
		<Card
			icon={LayoutGrid}
			title="Rack"
			sub="every task, newest first"
			status={<RackArrows state={scroll} newer="Scroll to newer tasks" older="Scroll to older tasks" />}
		>
			<CardSection ruled={false} className="pt-1">
				<RackWell
					bays={bays}
					look={taskLook}
					details={(session) => <TaskDetails session={session} />}
					detailsLabel={(session) => session.title}
					onChoose={(session) => void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code' } })}
					label={`${sessions.length} tasks as blades in a rack`}
					onScrollState={setScroll}
				/>
			</CardSection>
		</Card>
	);
}
