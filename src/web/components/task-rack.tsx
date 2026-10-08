import { useNavigate } from '@tanstack/react-router';
import { type CSSProperties, type KeyboardEvent, type ReactNode, useState } from 'react';
import { Block, COS, DETAIL, EDGE, fmt, Ln, OnFace, type Pair, pt, RECESS, SIN, Slot, ve } from '@/components/illustrations';
import { isLive, liveLabel } from '@/components/task-status';
import type { Session } from '@/lib/api';
import { age, dollars } from '@/lib/format';

/* The latest tasks as blades in a rack, drawn like the other isometric
   objects. Each blade's light shows how its task stands; pointing at one (or
   tabbing to it) slides it out and opens a card with its details, and choosing
   it opens the task. */

export const RACK_SLOTS = 12;

const PITCH = 12;
const BLADE = 10;
const INSET = 8;
const WIDTH = INSET * 2 + RACK_SLOTS * PITCH - (PITCH - BLADE);
const DEPTH = 50;
const HEIGHT = 60;
const PLINTH = 6;
/** How far a blade slides out when it is chosen. */
const PULL = 20;
const BLADE_Z = PLINTH + 7;
const BLADE_H = 46;

const VIEW = { x: -62, y: -74, w: 212, h: 188 };

type Kind = 'live' | 'pr' | 'failed' | 'stopped';

/** The same four states, in the same colours, as the split bar in the card beside it, which is the legend. */
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

/** A point given in the drawing's units, as a share of the drawing's box. */
const share = ([x, y]: Pair) => ({ left: `${((x - VIEW.x) / VIEW.w) * 100}%`, top: `${((y - VIEW.y) / VIEW.h) * 100}%` });

const slotX = (index: number) => INSET + index * PITCH;

/** Where the details card hangs from: the top of a pulled-out blade's front plate. */
const anchor = (index: number) => pt([slotX(index) + BLADE / 2, DEPTH + PULL + 1, BLADE_Z + BLADE_H]);

type Handlers = { onOpen: () => void; onClose: () => void; onChoose: () => void };

/** One blade. The interactive ones stay in slot order; the open one is drawn a
    second time on top as a copy (`copy`) that takes no input, so it covers its
    neighbours without the real one moving in the document and losing focus. */
function Blade({ session, index, open, copy, handlers }: { session: Session; index: number; open: boolean; copy?: boolean; handlers?: Handlers }) {
	const kind = kindOf(session);
	const lit = open || kind === 'live';
	const x = slotX(index);
	// Out of the rack is home; sliding back by the pull puts its plate flush with the front.
	const rest = `translate(${fmt(PULL * COS)}px, ${fmt(-PULL * SIN)}px)`;
	const [tipX, tipY] = anchor(index);
	return (
		<g
			{...(copy || !handlers
				? { 'aria-hidden': true, style: { pointerEvents: 'none' } as CSSProperties }
				: {
						className: 'rack-blade',
						style: { '--slot': index } as CSSProperties,
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
						at={[x + 0.6, DEPTH, BLADE_Z + 1]}
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
								<rect x={4.5} y={22} width={7} height={7} rx={1} fill="var(--art-top)" stroke={EDGE} {...ve} />
								<rect x={4.5} y={9} width={4} height={9} rx={0.8} fill="var(--art-top)" stroke={DETAIL} {...ve} />
								<rect x={11} y={9} width={4} height={9} rx={0.8} fill="var(--art-top)" stroke={DETAIL} {...ve} />
								<Ln a={[11.5, 25.5]} b={[16, 25.5]} />
								<Ln a={[8, 29]} b={[8, 33]} />
								<Ln a={[8, 33]} b={[14, 33]} />
								<circle cx={14.5} cy={33} r={0.9} fill={kind === 'live' ? 'var(--cyan-300)' : DETAIL} />
							</>
						}
					/>
				</g>
				<Block
					at={[x, DEPTH + PULL, BLADE_Z]}
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
				<g className="rack-tip">
					<line x1={tipX} y1={tipY - 2} x2={tipX} y2={tipY - 11} stroke="var(--accent-base)" strokeDasharray="1.5 2" {...ve} />
					<circle cx={tipX} cy={tipY - 1} r={1.5} fill="var(--accent-base)" />
				</g>
			) : null}
		</g>
	);
}

/** The rack's cabinet: the plinth it stands on, the slots in its front, the
    vents and the sweep of the indexing light across its lid. */
function Cabinet() {
	return (
		<>
			<Block
				at={[-4, -4, 0]}
				size={[WIDTH + 8, DEPTH + 8, PLINTH]}
				r={2}
				left={Array.from({ length: RACK_SLOTS }, (_, i) => (
					<rect key={i} x={4 + slotX(i) + BLADE / 2 - 1} y={2.6} width={2} height={0.9} rx={0.45} fill={DETAIL} />
				))}
			/>
			<Block
				at={[0, 0, PLINTH]}
				size={[WIDTH, DEPTH, HEIGHT]}
				r={3.5}
				top={
					<>
						{Array.from({ length: 9 }, (_, i) => (
							<Slot key={i} x={10 + i * 15} y={8} w={9} h={2.4} r={1.2} />
						))}
						<Slot x={10} y={DEPTH - 16} w={WIDTH - 20} h={8} r={2} edge />
						<g className="rack-sweep">
							<line x1={12} y1={DEPTH - 14.6} x2={12} y2={DEPTH - 9.4} stroke="var(--cyan-200)" strokeWidth={1.4} {...ve} />
						</g>
					</>
				}
				left={
					<>
						{Array.from({ length: RACK_SLOTS }, (_, i) => (
							<Slot key={i} x={slotX(i) - 0.6} y={6} w={BLADE + 1.2} h={BLADE_H + 1.2} r={1.4} />
						))}
						<rect x={INSET} y={HEIGHT - 4.4} width={34} height={1.4} rx={0.7} fill={DETAIL} />
					</>
				}
				right={
					<>
						<Slot x={8} y={8} w={DEPTH - 16} h={HEIGHT - 20} r={2} edge />
						{Array.from({ length: 8 }, (_, i) => (
							<Ln key={i} a={[12, 13 + i * 4.4]} b={[DEPTH - 12, 13 + i * 4.4]} />
						))}
						<circle cx={DEPTH - 9} cy={HEIGHT - 6} r={1.4} fill="var(--cyan-300)" />
					</>
				}
			/>
		</>
	);
}

function Details({ session, index }: { session: Session; index: number }) {
	const kind = kindOf(session);
	const where = share(anchor(index));
	const model = session.model.split('/').pop() ?? session.model;
	const facts: Array<[string, ReactNode]> = [
		['spent', dollars(session.usage.cost)],
		['model', model],
		['branch', session.workspace ? session.branch : `${session.baseBranch} · read-only`],
	];
	return (
		<div
			className="in-pop pointer-events-none absolute z-10 flex w-[248px] flex-col gap-2 px-3 py-2.5 text-left"
			// Slid along by the blade's place in the row, so the first card opens to the right of its blade and the last to the left.
			style={{ ...where, transform: `translate(${-Math.round((index / (RACK_SLOTS - 1)) * 100)}%, calc(-100% - 22px))` }}
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

/** The newest tasks, one blade each, in the order the list below shows them. */
export function TaskRack({ sessions, className }: { sessions: Session[]; className?: string }) {
	const navigate = useNavigate();
	const [open, setOpen] = useState<number | null>(null);
	// The blade drawn on top: the open one, and after it closes, the last one
	// opened, so its copy slides back in with it.
	const [top, setTop] = useState<number | null>(null);
	const shown = sessions.slice(0, RACK_SLOTS);
	const choose = (session: Session) => void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code' } });
	return (
		<div className={`relative ${className ?? ''}`}>
			<svg role="group" aria-label="The latest tasks as blades in a rack" viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`} className="block h-auto w-full overflow-visible" fill="none">
				<Cabinet />
				{shown.map((session, index) => (
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
							onClose: () => setOpen((current) => (current === index ? null : current)),
							onChoose: () => choose(session),
						}}
					/>
				))}
				{top !== null && shown[top] ? <Blade key={`copy-${top}`} session={shown[top]} index={top} open={open === top} copy /> : null}
			</svg>
			{open !== null && shown[open] ? <Details session={shown[open]} index={open} /> : null}
		</div>
	);
}

