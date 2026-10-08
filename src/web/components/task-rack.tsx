import { useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Server } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Block, COS, DETAIL, EDGE, fmt, Ln, type Pair, pt, RECESS, SIN, Slot, ve } from '@/components/illustrations';
import { Card, CardFooter, CardSection } from '@/components/instrument';
import { IconBtn } from '@/components/signal';
import { isLive, liveLabel } from '@/components/task-status';
import type { Session } from '@/lib/api';
import { age, dollars } from '@/lib/format';

/* Every task as a blade in a row of rack bays, drawn like the other isometric
   objects. Each blade's light shows how its task stands; pointing at one (or
   tabbing to it) slides it out and opens a card with its details, and choosing
   it opens the task. The row fits as many bays as the card is wide; when there
   are more tasks than blades, Newer and Older page through them, and the floor
   line runs on past the end of the row toward the tasks not shown. */

/** Blades in one bay. */
const PER_BAY = 8;
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
const SPAN = 168;
const TOP = -128;
const BOTTOM = 56;
/** Roughly how wide a bay is drawn on the page, used to decide how many fit. */
const BAY_PX = 225;
const MAX_BAYS = 6;

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
    of the indexing light across its lid. Its number range sits above it. */
function Bay({ bay, first, filled }: { bay: number; first: number; filled: number }) {
	const [ox, oy] = bayOrigin(bay);
	const [lx] = pt([ox + BAY_W / 2, oy + DEPTH / 2, 0]);
	const [, ly] = pt([ox, oy, PLINTH + HEIGHT]);
	const number = (n: number) => String(n).padStart(2, '0');
	const range = filled > 1 ? `${number(first + 1)}–${number(first + filled)}` : filled ? number(first + 1) : 'empty';
	return (
		<g opacity={filled ? 1 : 0.5}>
			<text x={lx} y={ly - 12} textAnchor="middle" fill={filled ? 'var(--text-tertiary)' : 'var(--text-disabled)'} style={{ font: '500 8.5px var(--font-mono)', letterSpacing: '0.08em' }}>
				{range}
			</text>
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
						{Array.from({ length: 6 }, (_, i) => (
							<Slot key={i} x={10 + i * 16} y={8} w={10} h={2.4} r={1.2} />
						))}
						<Slot x={10} y={DEPTH - 15} w={BAY_W - 20} h={8} r={2} edge />
						{filled ? (
							<g className="rack-sweep" style={{ '--bay': bay } as CSSProperties}>
								<line x1={12} y1={DEPTH - 13.6} x2={12} y2={DEPTH - 8.4} stroke="var(--cyan-200)" strokeWidth={1.4} {...ve} />
							</g>
						) : null}
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

/** The floor line the bays stand on; past either end it runs on, with an arrow
    head, when there are tasks that way. */
function Floor({ width, newer, older }: { width: number; newer: boolean; older: boolean }) {
	const chevron = (x: number, dir: 1 | -1) => (
		<g stroke="var(--accent-base)" strokeLinecap="round" strokeLinejoin="round" fill="none">
			{[0, 6].map((offset) => (
				<polyline key={offset} points={`${x + dir * offset},-4 ${x + dir * (offset + 4)},0 ${x + dir * offset},4`} {...ve} />
			))}
		</g>
	);
	return (
		<g>
			<line x1={newer ? 0 : 20} y1={0} x2={older ? width : width - 20} y2={0} stroke={DETAIL} strokeDasharray="2 3" {...ve} />
			{newer ? chevron(14, -1) : null}
			{older ? chevron(width - 14, 1) : null}
		</g>
	);
}

function Details({ session, index, view }: { session: Session; index: number; view: { w: number; h: number } }) {
	const kind = kindOf(session);
	const [ax, ay] = anchor(index);
	const across = ax / view.w;
	const model = session.model.split('/').pop() ?? session.model;
	const facts: Array<[string, ReactNode]> = [
		['spent', dollars(session.usage.cost)],
		['model', model],
		['branch', session.workspace ? session.branch : `${session.baseBranch} · read-only`],
	];
	return (
		<div
			className="in-pop pointer-events-none absolute z-10 flex w-[248px] flex-col gap-2 px-3 py-2.5 text-left"
			// Slid along by the blade's place in the row, so cards near the ends open inward.
			style={{ left: `${across * 100}%`, top: `${((ay - TOP) / view.h) * 100}%`, transform: `translate(${-Math.round(across * 100)}%, calc(-100% - 22px))` }}
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

/** How many bays fit the element's width, kept up to date as it resizes. */
function useBays() {
	const ref = useRef<HTMLDivElement>(null);
	const [bays, setBays] = useState(4);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const fit = () => setBays(Math.max(1, Math.min(MAX_BAYS, Math.floor(element.clientWidth / BAY_PX))));
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return { ref, bays };
}

/** Every task, newest first, as blades in a row of bays across the card, a page at a time. */
export function RackCard({ sessions }: { sessions: Session[] }) {
	const navigate = useNavigate();
	const { ref, bays } = useBays();
	const perPage = bays * PER_BAY;
	const pages = Math.max(1, Math.ceil(sessions.length / perPage));
	const [page, setPage] = useState(0);
	// Which way the last page turn went, so the new bays come in from that side.
	const [from, setFrom] = useState<'newer' | 'older' | null>(null);
	const [open, setOpen] = useState<number | null>(null);
	// The blade drawn on top: the open one, and after it closes, the last one
	// opened, so its copy slides back in with it.
	const [top, setTop] = useState<number | null>(null);
	const current = Math.min(page, pages - 1);
	const start = current * perPage;
	const shown = sessions.slice(start, start + perPage);
	const view = { w: bays * SPAN, h: BOTTOM - TOP };

	useEffect(() => {
		setOpen(null);
		setTop(null);
	}, [current, bays]);

	const turn = (to: number) => {
		setFrom(to > current ? 'older' : 'newer');
		setPage(to);
	};
	const choose = (session: Session) => void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code' } });
	const range = sessions.length ? `${start + 1}–${start + shown.length} of ${sessions.length}` : 'none yet';

	return (
		<Card
			icon={Server}
			title="Rack"
			sub="every task, newest first"
			status={
				<div className="flex items-center gap-1">
					<IconBtn icon={ChevronLeft} label="Newer tasks" size="sm" disabled={current === 0} onClick={() => turn(current - 1)} />
					<span className="in-caption in-num min-w-[92px] text-center">{range}</span>
					<IconBtn icon={ChevronRight} label="Older tasks" size="sm" disabled={current >= pages - 1} onClick={() => turn(current + 1)} />
				</div>
			}
			footer={<CardFooter caption={pages > 1 ? `Page ${current + 1} of ${pages} · lights as in the split bar · point at a blade to pull it` : 'Lights as in the split bar · point at a blade to pull it'} />}
		>
			<CardSection ruled={false} className="pt-1">
				<div ref={ref} className="in-well in-grid relative px-6 pt-14 pb-4">
					<div className="relative">
						<svg role="group" aria-label={`Tasks ${range}, as blades in a rack`} viewBox={`0 ${TOP} ${view.w} ${view.h}`} className="block h-auto w-full overflow-visible" fill="none">
							<Floor width={view.w} newer={current > 0} older={current < pages - 1} />
							<g key={`${current}-${bays}`}>
								{Array.from({ length: bays }, (_, bay) => {
									const filled = Math.max(0, Math.min(PER_BAY, shown.length - bay * PER_BAY));
									return (
										<g key={bay} className="rack-bay" data-from={from ?? undefined} style={{ '--bay': bay } as CSSProperties}>
											<Bay bay={bay} first={start + bay * PER_BAY} filled={filled} />
											{shown.slice(bay * PER_BAY, bay * PER_BAY + filled).map((session, slot) => {
												const index = bay * PER_BAY + slot;
												return (
													<Blade
														key={session.id}
														session={session}
														index={index}
														open={open === index}
														handlers={{
															onOpen: () => {
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
								{top !== null && shown[top] ? <Blade key={`copy-${top}`} session={shown[top]} index={top} open={open === top} copy /> : null}
							</g>
						</svg>
						{open !== null && shown[open] ? <Details session={shown[open]} index={open} view={view} /> : null}
					</div>
				</div>
			</CardSection>
		</Card>
	);
}
