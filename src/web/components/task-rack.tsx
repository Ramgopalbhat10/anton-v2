import { useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Server } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Block, COS, DETAIL, EDGE, fmt, Ln, type Pair, pt, RECESS, SIN, Slot, ve } from '@/components/illustrations';
import { Card, CardFooter, CardSection } from '@/components/instrument';
import { IconBtn } from '@/components/signal';
import { isLive, liveLabel } from '@/components/task-status';
import type { Session } from '@/lib/api';
import { age, dollars } from '@/lib/format';

/* Every task as a blade in a row of rack bays, drawn like the other isometric
   objects. Each blade's light shows how its task stands; pointing at one (or
   tabbing to it) slides it out and opens a card with its details, and choosing
   it opens the task. The row is as long as it needs to be and scrolls sideways:
   by trackpad or wheel, by dragging it with a glide when let go, or by the
   arrows in the card's header. */

/** Blades in one bay. */
const PER_BAY = 10;
const PITCH = 12;
const BLADE = 10;
const INSET = 8;
const BAY_W = INSET * 2 + PER_BAY * PITCH - (PITCH - BLADE);
const DEPTH = 44;
const HEIGHT = 60;
const PLINTH = 6;
/** How far a blade slides out when it is chosen. */
const PULL = 18;
const BLADE_Z = PLINTH + 7;
const BLADE_H = 46;

/** Each bay's share of the row, in screen units, and the row's height. */
const SPAN = 184;
const TOP = -118;
const BOTTOM = 54;
/** How wide each bay's share is drawn on the page, so bays keep one size however many there are. */
const BAY_PX = 250;
const SCALE = BAY_PX / SPAN;

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

/** The back corner of bay `bay`, placed so the middle of its footprint lands on
    its column in a row that runs straight across the screen. */
function bayOrigin(bay: number): Pair {
	const t = (SPAN * (bay + 0.5)) / (2 * COS);
	return [t - BAY_W / 2, -t - DEPTH / 2];
}

/** Where blade `slot` of a bay stands along the bay's front. */
const slotX = (slot: number) => INSET + slot * PITCH;

/** Where the details card hangs from: the top of a pulled-out blade's front plate. */
function anchor(index: number): Pair {
	const [ox, oy] = bayOrigin(Math.floor(index / PER_BAY));
	return pt([ox + slotX(index % PER_BAY) + BLADE / 2, oy + DEPTH + PULL + 1, BLADE_Z + BLADE_H]);
}

type Handlers = { onOpen: () => void; onClose: () => void; onChoose: () => void };

/** One blade. The interactive ones stay in slot order; the open one is drawn a
    second time on top as a copy (`copy`) that takes no input, so it covers its
    neighbours without the real one moving in the document and losing focus. */
function Blade({ session, index, open, copy, handlers }: { session: Session; index: number; open: boolean; copy?: boolean; handlers?: Handlers }) {
	const kind = kindOf(session);
	const lit = open || kind === 'live';
	const slot = index % PER_BAY;
	const [ox, oy] = bayOrigin(Math.floor(index / PER_BAY));
	const x = ox + slotX(slot);
	// Out of the rack is home; sliding back by the pull puts its plate flush with the front.
	const rest = `translate(${fmt(PULL * COS)}px, ${fmt(-PULL * SIN)}px)`;
	const [tipX, tipY] = anchor(index);
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
			<g className="rack-slide" style={{ transform: open ? 'none' : rest }}>
				<g className="rack-body" style={{ opacity: open ? 1 : 0 }}>
					<Block
						at={[x + 0.6, oy + DEPTH, BLADE_Z + 1]}
						size={[BLADE - 1.2, PULL, BLADE_H - 2]}
						r={1}
						top={
							<>
								<Ln a={[2, 2]} b={[2, PULL - 2]} />
								<Ln a={[BLADE - 3.2, 2]} b={[BLADE - 3.2, PULL - 2]} />
							</>
						}
						right={
							<>
								<rect x={2} y={4} width={PULL - 4} height={BLADE_H - 10} rx={1.5} fill={RECESS} stroke={DETAIL} {...ve} />
								<rect x={4} y={22} width={7} height={7} rx={1} fill="var(--art-top)" stroke={EDGE} {...ve} />
								<rect x={4} y={9} width={4} height={9} rx={0.8} fill="var(--art-top)" stroke={DETAIL} {...ve} />
								<rect x={10} y={9} width={4} height={9} rx={0.8} fill="var(--art-top)" stroke={DETAIL} {...ve} />
								<Ln a={[11, 25.5]} b={[14.5, 25.5]} />
								<Ln a={[7.5, 29]} b={[7.5, 33]} />
								<Ln a={[7.5, 33]} b={[13, 33]} />
								<circle cx={13.5} cy={33} r={0.9} fill={kind === 'live' ? 'var(--cyan-300)' : DETAIL} />
							</>
						}
					/>
				</g>
				<Block
					at={[x, oy + DEPTH + PULL, BLADE_Z]}
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
			{open && copy ? (
				<g>
					<line x1={tipX} y1={tipY - 2} x2={tipX} y2={tipY - 11} stroke="var(--accent-base)" strokeDasharray="1.5 2" {...ve} />
					<circle cx={tipX} cy={tipY - 1} r={1.5} fill="var(--accent-base)" />
				</g>
			) : null}
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

/** The card for the open blade. It sits outside the scrolling row, so the row
    cannot clip it; `at` is where the blade's top is, in the well's pixels, and
    `across` how far along the well that is, so cards near the ends open inward. */
function Details({ session, at, across }: { session: Session; at: Pair; across: number }) {
	const kind = kindOf(session);
	const model = session.model.split('/').pop() ?? session.model;
	const facts: Array<[string, ReactNode]> = [
		['spent', dollars(session.usage.cost)],
		['model', model],
		['branch', session.workspace ? session.branch : `${session.baseBranch} · read-only`],
	];
	return (
		<div
			className="in-pop pointer-events-none absolute z-10 flex w-[248px] flex-col gap-2 px-3 py-2.5 text-left"
			style={{ left: at[0], top: at[1], transform: `translate(${-Math.round(across * 100)}%, calc(-100% - 22px))` }}
			role="status"
		>
			<div className="flex items-center gap-1.5">
				<span className={`size-1.5 shrink-0 rounded-full ${kind === 'live' ? 'in-pulse' : ''}`} style={{ background: KINDS[kind].color }} />
				<span className="in-caption text-(--text-secondary)">{stateWord(session)}</span>
				<span className="in-caption ml-auto">{age(session.createdAt)} ago</span>
			</div>
			<div className="line-clamp-2 text-[13px] leading-[18px] font-medium text-(--text-primary)">{session.title}</div>
			<div className="truncate font-mono text-[11px] text-(--text-tertiary)">{session.repo}</div>
			<div className="flex flex-col gap-1 border-t border-(--border-subtle) pt-2">
				{facts.map(([label, value]) => (
					<div key={label} className="flex min-w-0 items-baseline gap-2 text-[11.5px]">
						<span className="in-caption w-12 shrink-0">{label}</span>
						<span className="min-w-0 flex-1 truncate text-right text-(--text-secondary)">{value}</span>
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * Sideways scrolling for the row: native scrolling for trackpads, wheels and
 * touch, plus dragging with the mouse, which glides on for a moment when let
 * go. `moved` tells a click that ends a drag from a real click.
 */
function useDragScroll() {
	const ref = useRef<HTMLDivElement>(null);
	const [dragging, setDragging] = useState(false);
	const [edges, setEdges] = useState({ start: true, end: true });
	const drag = useRef<{ x: number; left: number; last: number; at: number; speed: number; moved: boolean } | null>(null);
	const moved = useRef(false);
	const glide = useRef(0);

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
		return () => {
			observer.disconnect();
			cancelAnimationFrame(glide.current);
		};
	}, [measure]);

	const still = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	const release = () => {
		const state = drag.current;
		drag.current = null;
		if (!state?.moved) return;
		setDragging(false);
		if (still()) return;
		// Carry on at the speed it was let go at, slowing to a stop.
		let speed = -state.speed;
		let last = performance.now();
		const step = (now: number) => {
			const element = ref.current;
			if (!element || Math.abs(speed) < 0.02) return;
			const elapsed = now - last;
			last = now;
			element.scrollLeft += speed * elapsed;
			speed *= 0.94 ** (elapsed / 16);
			glide.current = requestAnimationFrame(step);
		};
		glide.current = requestAnimationFrame(step);
	};

	const handlers = {
		onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
			if (event.pointerType !== 'mouse' || event.button !== 0 || !ref.current) return;
			cancelAnimationFrame(glide.current);
			moved.current = false;
			drag.current = { x: event.clientX, left: ref.current.scrollLeft, last: event.clientX, at: event.timeStamp, speed: 0, moved: false };
		},
		onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
			const state = drag.current;
			const element = ref.current;
			if (!state || !element) return;
			const dx = event.clientX - state.x;
			if (!state.moved && Math.abs(dx) > 4) {
				state.moved = true;
				moved.current = true;
				element.setPointerCapture(event.pointerId);
				setDragging(true);
			}
			if (!state.moved) return;
			element.scrollLeft = state.left - dx;
			const elapsed = Math.max(1, event.timeStamp - state.at);
			state.speed = (event.clientX - state.last) / elapsed;
			state.last = event.clientX;
			state.at = event.timeStamp;
		},
		onPointerUp: release,
		onPointerCancel: release,
		onScroll: measure,
	};

	/** Scrolls most of a view's width one way, smoothly unless motion is reduced. */
	const page = (direction: 1 | -1) => {
		const element = ref.current;
		if (!element) return;
		cancelAnimationFrame(glide.current);
		element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: still() ? 'auto' : 'smooth' });
	};

	return { ref, handlers, dragging, edges, page, moved };
}

/** Every task, newest first, as blades in a row of bays across the card; the row scrolls sideways when it is longer than the card. */
export function RackCard({ sessions }: { sessions: Session[] }) {
	const navigate = useNavigate();
	const scroll = useDragScroll();
	const well = useRef<HTMLDivElement>(null);
	const svg = useRef<SVGSVGElement>(null);
	const [open, setOpen] = useState<number | null>(null);
	// The blade drawn on top: the open one, and after it closes, the last one
	// opened, so its copy slides back in with it.
	const [top, setTop] = useState<number | null>(null);
	const [card, setCard] = useState<{ at: Pair; across: number } | null>(null);
	const bays = Math.max(1, Math.ceil(sessions.length / PER_BAY));
	const view = { w: bays * SPAN, h: BOTTOM - TOP };
	const scrolls = !(scroll.edges.start && scroll.edges.end);

	/** Where the open blade's card goes, measured from the drawing as it sits now. */
	const place = useCallback((index: number) => {
		if (!well.current || !svg.current) return;
		const box = well.current.getBoundingClientRect();
		const drawing = svg.current.getBoundingClientRect();
		const [ax, ay] = anchor(index);
		const x = drawing.left - box.left + ax * SCALE;
		setCard({ at: [x, drawing.top - box.top + (ay - TOP) * SCALE], across: Math.min(1, Math.max(0, x / box.width)) });
	}, []);

	useEffect(() => {
		if (open !== null) place(open);
	}, [open, place]);

	const choose = (session: Session) => {
		if (scroll.moved.current) return;
		void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code' } });
	};
	// Soft edges on whichever side has more of the row out of view.
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
							<IconBtn icon={ChevronLeft} label="Scroll to newer tasks" size="sm" disabled={scroll.edges.start} onClick={() => scroll.page(-1)} />
							<IconBtn icon={ChevronRight} label="Scroll to older tasks" size="sm" disabled={scroll.edges.end} onClick={() => scroll.page(1)} />
						</>
					) : null}
				</div>
			}
			footer={<CardFooter caption={scrolls ? 'Drag or scroll sideways · point at a blade to pull it' : 'Lights as in the split bar · point at a blade to pull it'} />}
		>
			<CardSection ruled={false} className="pt-1">
				<div ref={well} className="in-well in-grid relative pt-16 pb-3">
					<div
						ref={scroll.ref}
						className="rack-scroll overflow-x-auto overflow-y-hidden px-4 pb-2"
						data-dragging={scroll.dragging || undefined}
						style={{ maskImage: fade, WebkitMaskImage: fade }}
						{...scroll.handlers}
						onScroll={() => {
							scroll.handlers.onScroll();
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
															if (scroll.dragging) return;
															setOpen(index);
															setTop(index);
														},
														onClose: () => setOpen((now) => (now === index ? null : now)),
														onChoose: () => choose(session),
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
					{open !== null && sessions[open] && card ? <Details session={sessions[open]} at={card.at} across={card.across} /> : null}
				</div>
			</CardSection>
		</Card>
	);
}
