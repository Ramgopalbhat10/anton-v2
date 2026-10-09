import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUp, ArrowUpRight, ChevronLeft, ChevronRight, GitFork, GitPullRequest, Server, Square } from 'lucide-react';
import { type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Block, COS, DETAIL, EDGE, fmt, Ln, type Pair, pt, RECESS, Slot, ve } from '@/components/illustrations';
import { Card, CardFooter, CardSection } from '@/components/instrument';
import { Btn, Icon, IconBtn } from '@/components/signal';
import { useFork } from '@/components/task-actions';
import { isLive, liveLabel } from '@/components/task-status';
import { api, type Session } from '@/lib/api';
import { age, dollars, tokens } from '@/lib/format';
import { useModels } from '@/components/model-picker';
import { setPendingPrompt } from '@/lib/pending-prompt';

/* Every task as a blade in a row of rack bays, drawn like the other isometric
   objects. Each blade's light shows how its task stands. Pointing at one (or
   tabbing to it) draws it out of its slot and opens a card with its details and
   what can be done with it: open it, send it a follow-up, fork it, stop it or
   go to its pull request. The card stays while the pointer is on it. The row is
   as long as it needs to be and scrolls sideways, or by the header's arrows. */

/** Blades in one bay. */
const PER_BAY = 10;
const PITCH = 12;
const BLADE = 10;
const INSET = 8;
const BAY_W = INSET * 2 + PER_BAY * PITCH - (PITCH - BLADE);
const DEPTH = 44;
const HEIGHT = 60;
const PLINTH = 6;
/** How far a blade comes out of its slot, and how long the whole way takes. */
const PULL = 18;
const SLIDE_MS = 620;
const BLADE_Z = PLINTH + 7;
const BLADE_H = 46;

/** Each bay's share of the row, in screen units, and the row's height. */
const SPAN = 184;
const TOP = -118;
const BOTTOM = 54;
/** How wide each bay's share is drawn on the page, so bays keep one size however many there are. */
const BAY_PX = 250;
const SCALE = BAY_PX / SPAN;
/** How long the card waits after the pointer leaves its blade or itself, so it can be reached. */
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

/** The back corner of bay `bay`, placed so the middle of its footprint lands on
    its column in a row that runs straight across the screen. */
function bayOrigin(bay: number): Pair {
	const t = (SPAN * (bay + 0.5)) / (2 * COS);
	return [t - BAY_W / 2, -t - DEPTH / 2];
}

/** Where blade `slot` of a bay stands along the bay's front. */
const slotX = (slot: number) => INSET + slot * PITCH;

/** Where the card's leader starts on a fully drawn-out blade, at half its
    height: the far edge of its body on the right, its plate's edge on the left. */
function bladeSides(index: number): { left: Pair; right: Pair } {
	const [ox, oy] = bayOrigin(Math.floor(index / PER_BAY));
	const x = ox + slotX(index % PER_BAY);
	const z = BLADE_Z + BLADE_H / 2;
	return { left: pt([x, oy + DEPTH + PULL + 2.2, z]), right: pt([x + BLADE, oy + DEPTH, z]) };
}

/**
 * How far a blade is out of its slot: eased toward all the way out while it is
 * open and back in when it closes, starting from wherever it is, so a blade let
 * go halfway slides straight back.
 */
function useDrawOut(out: boolean) {
	const [pull, setPull] = useState(0);
	const now = useRef(0);
	useEffect(() => {
		const goal = out ? PULL : 0;
		const from = now.current;
		if (from === goal) return;
		if (reducedMotion()) {
			now.current = goal;
			setPull(goal);
			return;
		}
		const duration = Math.max(160, (SLIDE_MS * Math.abs(goal - from)) / PULL);
		const start = performance.now();
		let frame = 0;
		const step = (time: number) => {
			const k = Math.min(1, (time - start) / duration);
			const eased = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
			now.current = from + (goal - from) * eased;
			setPull(now.current);
			if (k < 1) frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [out]);
	return pull;
}

type Handlers = { onOpen: () => void; onClose: () => void; onChoose: () => void };

/**
 * One blade. Only the part of it that is out of the cabinet is drawn: the body
 * runs from the cabinet's front to the plate and grows as the blade slides out,
 * with its board moving along with the plate, so it comes out of its slot
 * rather than over the rack. The interactive ones stay in slot order; the open
 * one is drawn a second time on top as a copy (`copy`) that takes no input, so
 * it covers its neighbours without the real one moving in the document and
 * losing focus.
 */
function Blade({ session, index, open, copy, handlers }: { session: Session; index: number; open: boolean; copy?: boolean; handlers?: Handlers }) {
	const kind = kindOf(session);
	const lit = open || kind === 'live';
	const slot = index % PER_BAY;
	const [ox, oy] = bayOrigin(Math.floor(index / PER_BAY));
	const x = ox + slotX(slot);
	const front = oy + DEPTH;
	const pull = useDrawOut(open);
	// The board is fixed to the plate, so it slides out with it.
	const behind = fmt(pull - PULL);
	return (
		<g
			{...(copy || !handlers
				? { 'aria-hidden': true, style: { pointerEvents: 'none' } as CSSProperties }
				: {
						className: 'rack-blade',
						style: { '--slot': slot } as CSSProperties,
						role: 'link',
						tabIndex: 0,
						'aria-label': `${session.title}, ${stateWord(session)}`,
						onPointerEnter: handlers.onOpen,
						onPointerLeave: handlers.onClose,
						onFocus: handlers.onOpen,
						onBlur: handlers.onClose,
						onClick: handlers.onChoose,
						onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								handlers.onChoose();
							}
						},
					})}
		>
			{pull > 0.5 ? (
				<Block
					at={[x + 0.6, front, BLADE_Z + 1]}
					size={[BLADE - 1.2, pull, BLADE_H - 2]}
					r={Math.min(1, pull / 3)}
					top={
						<g transform={`translate(0 ${behind})`}>
							<Ln a={[2, 2]} b={[2, PULL - 2]} />
							<Ln a={[BLADE - 3.2, 2]} b={[BLADE - 3.2, PULL - 2]} />
						</g>
					}
					right={
						<g transform={`translate(${behind} 0)`}>
							<rect x={2} y={4} width={PULL - 4} height={BLADE_H - 10} rx={1.5} fill={RECESS} stroke={DETAIL} {...ve} />
							<rect x={4} y={22} width={7} height={7} rx={1} fill="var(--art-top)" stroke={EDGE} {...ve} />
							<rect x={4} y={9} width={4} height={9} rx={0.8} fill="var(--art-top)" stroke={DETAIL} {...ve} />
							<rect x={10} y={9} width={4} height={9} rx={0.8} fill="var(--art-top)" stroke={DETAIL} {...ve} />
							<Ln a={[11, 25.5]} b={[14.5, 25.5]} />
							<Ln a={[7.5, 29]} b={[7.5, 33]} />
							<Ln a={[7.5, 33]} b={[13, 33]} />
							<circle cx={13.5} cy={33} r={0.9} fill={kind === 'live' ? 'var(--cyan-300)' : DETAIL} />
						</g>
					}
				/>
			) : null}
			<Block
				at={[x, front + pull, BLADE_Z]}
				size={[BLADE, 2.2, BLADE_H]}
				r={1.4}
				tone={lit ? 'accent' : 'solid'}
				left={
					<>
						<Slot x={3} y={5} w={4} h={9} r={1.2} edge />
						{[17, 19.4, 21.8, 24.2, 26.6].map((v) => (
							<rect key={v} x={3} y={v} width={4} height={0.9} rx={0.45} fill={lit ? 'var(--accent-base)' : DETAIL} />
						))}
						{kind === 'live'
							? [30, 33, 36].map((v, k) => <circle key={v} className="rack-activity" style={{ '--blink': k } as CSSProperties} cx={5} cy={v} r={0.75} fill="var(--cyan-200)" />)
							: null}
						<circle className={kind === 'live' ? 'in-pulse' : undefined} cx={5} cy={41} r={1.5} fill={KINDS[kind].color} />
					</>
				}
			/>
		</g>
	);
}

/** One bay's cabinet: its plinth, the slots in its front, vents, and the sweep
    of the indexing light across its lid. */
function Bay({ bay, filled }: { bay: number; filled: number }) {
	const [ox, oy] = bayOrigin(bay);
	return (
		<g>
			<Block
				at={[ox - 4, oy - 4, 0]}
				size={[BAY_W + 8, DEPTH + 8, PLINTH]}
				r={2}
				left={Array.from({ length: PER_BAY }, (_, i) => (
					<rect key={i} x={4 + slotX(i) + BLADE / 2 - 1} y={2.6} width={2} height={0.9} rx={0.45} fill={i < filled ? DETAIL : 'none'} />
				))}
			/>
			<Block
				at={[ox, oy, PLINTH]}
				size={[BAY_W, DEPTH, HEIGHT]}
				r={3.5}
				top={
					<>
						{Array.from({ length: 7 }, (_, i) => (
							<Slot key={i} x={10 + i * 17} y={8} w={11} h={2.4} r={1.2} />
						))}
						<Slot x={10} y={DEPTH - 15} w={BAY_W - 20} h={8} r={2} edge />
						<g className="rack-sweep" style={{ '--bay': bay } as CSSProperties}>
							<line x1={12} y1={DEPTH - 13.6} x2={12} y2={DEPTH - 8.4} stroke="var(--cyan-200)" strokeWidth={1.4} {...ve} />
						</g>
					</>
				}
				left={Array.from({ length: PER_BAY }, (_, i) => (
					<Slot key={i} x={slotX(i) - 0.6} y={6} w={BLADE + 1.2} h={BLADE_H + 1.2} r={1.4} />
				))}
				right={
					<>
						<Slot x={8} y={8} w={DEPTH - 16} h={HEIGHT - 20} r={2} edge />
						{Array.from({ length: 8 }, (_, i) => (
							<Ln key={i} a={[12, 13 + i * 4.4]} b={[DEPTH - 12, 13 + i * 4.4]} />
						))}
						<circle cx={DEPTH - 9} cy={HEIGHT - 6} r={1.4} fill={filled ? 'var(--cyan-300)' : DETAIL} />
					</>
				}
			/>
		</g>
	);
}

type Linger = { onPointerEnter: () => void; onPointerLeave: () => void; onFocus: () => void; onBlur: (event: FocusEvent<HTMLDivElement>) => void; onDismiss: () => void };

/** Where the open blade's card sits in the well: beside the blade, on the side with more room. */
type Placement = { side: 'left' | 'right'; from: Pair; edge: number };

const CARD_W = 300;
const GAP = 22;

/**
 * The card for the open blade, and what can be done with its task: send it a
 * follow-up (the task opens and sends it), fork it into a new task, stop it
 * while it runs, go to its pull request, or open it. It opens beside the blade,
 * with a dashed leader from the blade to it, and sits outside the scrolling row
 * so the row cannot clip it. The gap between them is bridged, so the pointer
 * can cross from the blade to the card.
 */
function Details({ session, placement, linger }: { session: Session; placement: Placement; linger: Linger }) {
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
	const { side, from, edge } = placement;
	const leader = side === 'right' ? { left: from[0], width: edge - from[0] } : { left: edge, width: from[0] - edge };
	return (
		<>
			<span aria-hidden className="rack-leader pointer-events-none absolute z-10 border-t border-dashed border-(--accent-base)" style={{ left: leader.left, top: from[1], width: leader.width }}>
				<span className="absolute -top-[3.5px] size-1.5 rounded-full bg-(--accent-base)" style={side === 'right' ? { left: -3 } : { right: -3 }} />
			</span>
			<div
				role="dialog"
				aria-label={session.title}
				className="rack-card in-pop absolute top-1/2 z-10 flex flex-col text-left"
				style={{ width: CARD_W, ...(side === 'right' ? { left: edge } : { left: edge - CARD_W }), transform: 'translateY(-50%)' }}
				onPointerEnter={linger.onPointerEnter}
				onPointerLeave={linger.onPointerLeave}
				onFocus={linger.onFocus}
				onBlur={linger.onBlur}
				onKeyDown={(event) => {
					if (event.key === 'Escape') linger.onDismiss();
				}}
			>
				<span aria-hidden className="absolute inset-y-0" style={side === 'right' ? { right: '100%', width: GAP + 8 } : { left: '100%', width: GAP + 8 }} />
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
					<div className="flex flex-col gap-1 rounded-[9px] border border-(--border-subtle) bg-(--well-bg) px-2.5 py-2">
						<div className="flex items-center gap-1.5">
							<span className="in-caption">{followedUp ? 'Latest input' : 'Input'}</span>
							<span className="in-caption ml-auto tracking-normal normal-case" title={new Date(latestAt).toLocaleString()}>
								{age(latestAt)} ago
							</span>
						</div>
						<p className="m-0 line-clamp-3 text-[13px] leading-[18px] text-pretty whitespace-pre-line text-(--text-primary)">{latest}</p>
					</div>
					<div className="truncate font-mono text-[11px] text-(--text-tertiary)">
						{session.repo.split('/').pop()} · {session.workspace ? session.branch : `${session.baseBranch} (read-only)`}
					</div>
				</div>
				<div className="grid grid-cols-[auto_auto_minmax(0,1fr)] border-t border-(--border-subtle)">
					{stats.map(([label, value], i) => (
						<div key={label} className={`flex min-w-0 flex-col gap-0.5 px-3.5 py-2 ${i ? 'border-l border-(--border-subtle)' : ''}`}>
							<span className="truncate text-[12.5px] text-(--text-primary)">{value}</span>
							<span className="in-caption">{label}</span>
						</div>
					))}
				</div>
				<form
					className="flex flex-col gap-2 border-t border-(--border-subtle) p-2.5"
					onSubmit={(event) => {
						event.preventDefault();
						send();
					}}
				>
					<div className="flex h-9 items-center gap-2 rounded-[10px] border border-(--border-subtle) bg-(--well-bg) pr-1 pl-3 focus-within:border-(--accent-border)">
						<input
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							placeholder="Send a follow-up…"
							aria-label={`Send a follow-up to ${session.title}`}
							className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12.5px] text-(--text-primary) outline-none placeholder:text-(--text-disabled)"
						/>
						<IconBtn icon={ArrowUp} label="Send to this task" size="xs" variant={prompt.trim() ? 'primary' : 'ghost'} type="submit" disabled={!prompt.trim()} />
					</div>
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
			</div>
		</>
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

/** Every task, newest first, as blades in a row of bays across the card; the row scrolls sideways when it is longer than the card. */
export function RackCard({ sessions }: { sessions: Session[] }) {
	const navigate = useNavigate();
	const scroll = useRowScroll();
	const well = useRef<HTMLDivElement>(null);
	const svg = useRef<SVGSVGElement>(null);
	const [open, setOpen] = useState<number | null>(null);
	// The blade drawn on top: the open one, and after it closes, the last one
	// opened, so its copy slides back in with it.
	const [top, setTop] = useState<number | null>(null);
	const [placement, setPlacement] = useState<Placement | null>(null);
	const closing = useRef(0);
	const bays = Math.max(1, Math.ceil(sessions.length / PER_BAY));
	const view = { w: bays * SPAN, h: BOTTOM - TOP };
	const scrolls = !(scroll.edges.start && scroll.edges.end);

	const hold = () => window.clearTimeout(closing.current);
	const letGo = () => {
		hold();
		closing.current = window.setTimeout(() => setOpen(null), LINGER_MS);
	};
	useEffect(() => hold, []);

	/** Where the open blade's card goes, measured from the drawing as it sits now:
	    beside the blade, on whichever side has room for it. */
	const place = useCallback((index: number) => {
		if (!well.current || !svg.current) return;
		const box = well.current.getBoundingClientRect();
		const drawing = svg.current.getBoundingClientRect();
		const toWell = ([x, y]: Pair): Pair => [drawing.left - box.left + x * SCALE, drawing.top - box.top + (y - TOP) * SCALE];
		const sides = bladeSides(index);
		const right = toWell(sides.right);
		const left = toWell(sides.left);
		const fitsRight = right[0] + GAP + CARD_W <= box.width - 8;
		setPlacement(fitsRight || left[0] - GAP - CARD_W < 8 ? { side: 'right', from: right, edge: right[0] + GAP } : { side: 'left', from: left, edge: left[0] - GAP });
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

	return (
		<Card
			icon={Server}
			title="Rack"
			sub="every task, newest first"
			status={
				<div className="flex items-center gap-1">
					<span className="in-caption in-num mr-1">
						{sessions.length} {sessions.length === 1 ? 'task' : 'tasks'}
					</span>
					{scrolls ? (
						<>
							<IconBtn icon={ChevronLeft} label="Scroll to newer tasks" size="sm" disabled={scroll.edges.start} onClick={() => scroll.step(-1)} />
							<IconBtn icon={ChevronRight} label="Scroll to older tasks" size="sm" disabled={scroll.edges.end} onClick={() => scroll.step(1)} />
						</>
					) : null}
				</div>
			}
			footer={<CardFooter caption={scrolls ? 'Scroll sideways for older tasks · point at a blade to draw it out' : 'Lights as in the split bar · point at a blade to draw it out'} />}
		>
			<CardSection ruled={false} className="pt-1">
				<div ref={well} className="in-well in-grid relative pt-10 pb-3">
					<div
						ref={scroll.ref}
						className="rack-scroll overflow-x-auto overflow-y-hidden px-4 pb-2"
						style={{ maskImage: fade, WebkitMaskImage: fade }}
						onScroll={() => {
							scroll.measure();
							// Keep the open card on its blade as the row moves under it.
							if (open !== null) place(open);
						}}
					>
						<svg
							ref={svg}
							role="group"
							aria-label={`${sessions.length} tasks as blades in a rack`}
							viewBox={`0 ${TOP} ${view.w} ${view.h}`}
							width={view.w * SCALE}
							height={view.h * SCALE}
							className="mx-auto block shrink-0 overflow-visible"
							fill="none"
						>
							{Array.from({ length: bays }, (_, bay) => {
								const filled = Math.max(0, Math.min(PER_BAY, sessions.length - bay * PER_BAY));
								return (
									<g key={bay}>
										<Bay bay={bay} filled={filled} />
										{sessions.slice(bay * PER_BAY, bay * PER_BAY + filled).map((session, slot) => {
											const index = bay * PER_BAY + slot;
											return (
												<Blade
													key={session.id}
													session={session}
													index={index}
													open={open === index}
													handlers={{
														onOpen: () => {
															hold();
															setOpen(index);
															setTop(index);
														},
														onClose: letGo,
														onChoose: () => void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code' } }),
													}}
												/>
											);
										})}
									</g>
								);
							})}
							{top !== null && sessions[top] ? <Blade key={`copy-${top}`} session={sessions[top]} index={top} open={open === top} copy /> : null}
						</svg>
					</div>
					{open !== null && sessions[open] && placement ? <Details key={sessions[open].id} session={sessions[open]} placement={placement} linger={linger} /> : null}
				</div>
			</CardSection>
		</Card>
	);
}
