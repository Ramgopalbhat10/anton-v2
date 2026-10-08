import { type CSSProperties, type ReactNode, useId } from 'react';
import { cn } from '@/lib/utils';

/* Isometric drawings for empty and quiet states, drawn like the objects on a
   technical sheet: rounded blocks in three flat tones, recesses cut into their
   faces, one hairline edge, and a single part picked out in cyan with a dashed
   leader to its label. They sit on the drafting grid of a well, so they bring
   no floor of their own.

   Everything is placed in a 3D grid and projected at 30°. Details are drawn in
   the 2D plane of the face they sit on (see OnFace), so a circle on a lid
   becomes the right ellipse and a slot on a side follows its slope. */

type Point = [number, number, number];
type Pair = [number, number];

const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;

const pt = ([x, y, z]: Point): Pair => [(x - y) * COS, (x + y) * SIN - z];
const fmt = (n: number) => (Math.abs(n) < 0.005 ? '0' : n.toFixed(2));
const pairs = (points: Pair[]) => points.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(' ');

const ve = { vectorEffect: 'non-scaling-stroke' } as const;
const EDGE = 'var(--art-edge)';
const DETAIL = 'var(--art-detail)';
const RECESS = 'var(--art-recess)';
const ACCENT = 'var(--accent-base)';

function useSvgId(prefix: string) {
	return `${prefix}${useId().replace(/[^\w-]/g, '')}`;
}

/** A closed path through the points with each corner rounded by up to r. */
function rounded(points: Pair[], r: number): string {
	const n = points.length;
	const dist = (a: Pair, b: Pair) => Math.hypot(a[0] - b[0], a[1] - b[1]);
	const toward = (from: Pair, to: Pair, k: number): Pair => {
		const length = dist(from, to) || 1;
		return [from[0] + ((to[0] - from[0]) * k) / length, from[1] + ((to[1] - from[1]) * k) / length];
	};
	let d = '';
	points.forEach((p, i) => {
		const prev = points[(i + n - 1) % n];
		const next = points[(i + 1) % n];
		const k = Math.min(r, dist(p, prev) / 2, dist(p, next) / 2);
		const a = toward(p, prev, k);
		const b = toward(p, next, k);
		d += `${i ? 'L' : 'M'} ${fmt(a[0])} ${fmt(a[1])} Q ${fmt(p[0])} ${fmt(p[1])} ${fmt(b[0])} ${fmt(b[1])} `;
	});
	return `${d}Z`;
}

/* ——— Faces ——— */

type Plane = 'left' | 'right' | 'top';

/** Where a face's local axes land on screen. Sides: u along the face, v up.
    Top: u along x, v along y. */
const AXES: Record<Plane, [number, number, number, number]> = {
	left: [COS, SIN, 0, -1],
	right: [-COS, SIN, 0, -1],
	top: [COS, SIN, -COS, SIN],
};

/** Draws its children in the plane of a face, with the origin at a grid point. */
function OnFace({ on, at, children }: { on: Plane; at: Point; children: ReactNode }) {
	const [ox, oy] = pt(at);
	return <g transform={`matrix(${AXES[on].map(fmt).join(' ')} ${fmt(ox)} ${fmt(oy)})`}>{children}</g>;
}

/** A recess cut into a face. */
function Slot({ x, y, w, h, r = 1, edge }: { x: number; y: number; w: number; h: number; r?: number; edge?: boolean }) {
	return <rect x={x} y={y} width={w} height={h} rx={r} fill={RECESS} stroke={edge ? DETAIL : 'none'} {...ve} />;
}

/** A line of text or a seam, as a short filled bar. */
function Bar({ x, y, w, h = 1.6, accent }: { x: number; y: number; w: number; h?: number; accent?: boolean }) {
	return <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={accent ? ACCENT : DETAIL} />;
}

function Ring({ at, r, fill = 'none', stroke = DETAIL }: { at: Pair; r: number; fill?: string; stroke?: string }) {
	return <circle cx={at[0]} cy={at[1]} r={r} fill={fill} stroke={stroke} {...ve} />;
}

function Ln({ a, b, stroke = DETAIL, dash }: { a: Pair; b: Pair; stroke?: string; dash?: string }) {
	return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={stroke} strokeDasharray={dash} strokeLinecap="round" {...ve} />;
}

function Trace({ points, stroke = DETAIL, dash }: { points: Pair[]; stroke?: string; dash?: string }) {
	return <polyline points={pairs(points)} fill="none" stroke={stroke} strokeDasharray={dash} strokeLinejoin="round" strokeLinecap="round" {...ve} />;
}

/** A status light: lit ones are cyan. */
function Led({ at, lit, r = 1.4 }: { at: Pair; lit?: boolean; r?: number }) {
	return <circle cx={at[0]} cy={at[1]} r={r} fill={lit ? 'var(--cyan-300)' : 'var(--art-detail)'} />;
}

/** Text written on a side face, reading along it. */
function Print({ at, size = 6, children }: { at: Pair; size?: number; children: ReactNode }) {
	return (
		<g transform={`translate(${at[0]} ${at[1]}) scale(1 -1)`}>
			<text fill="var(--text-secondary)" style={{ font: `500 ${size}px var(--font-mono)`, letterSpacing: '0.12em' }}>
				{children}
			</text>
		</g>
	);
}

/* ——— Solids ——— */

type Tone = 'solid' | 'accent' | 'glass';

const TONES: Record<Tone, { top: string; left: string; right: string; edge: string }> = {
	solid: { top: 'var(--art-top)', left: 'var(--art-left)', right: 'var(--art-right)', edge: EDGE },
	accent: { top: 'var(--art-accent-top)', left: 'var(--art-accent-left)', right: 'var(--art-accent-right)', edge: ACCENT },
	glass: { top: 'var(--art-glass)', left: 'var(--art-glass)', right: 'var(--art-glass)', edge: EDGE },
};

type Faces = { top?: ReactNode; left?: ReactNode; right?: ReactNode };

/** A block with softened edges, from its back corner at (x, y, z). Face details
    are clipped to its outline, so nothing spills past a rounded corner. */
function Block({ at, size, r = 3, tone = 'solid', dashed, top, left, right }: Faces & { at: Point; size: Point; r?: number; tone?: Tone; dashed?: boolean }) {
	const clip = useSvgId('blk');
	const [x, y, z] = at;
	const [w, d, h] = size;
	const A = pt([x, y, z + h]);
	const B = pt([x + w, y, z + h]);
	const C = pt([x + w, y, z]);
	const D = pt([x + w, y + d, z]);
	const E = pt([x, y + d, z]);
	const F = pt([x, y + d, z + h]);
	const G = pt([x + w, y + d, z + h]);
	const outline = rounded([A, B, C, D, E, F], r);
	const lid = rounded([A, B, G, F], r);
	const t = TONES[tone];
	const dash = dashed ? '3 3' : undefined;
	const edgeEnd = Math.max(G[1], D[1] - r);
	return (
		<g>
			<clipPath id={clip}>
				<path d={outline} />
			</clipPath>
			<g clipPath={`url(#${clip})`}>
				<polygon points={pairs([F, G, D, E])} fill={t.left} />
				<polygon points={pairs([G, B, C, D])} fill={t.right} />
				<path d={lid} fill={t.top} />
				{left ? <OnFace on="left" at={[x, y + d, z]}>{left}</OnFace> : null}
				{right ? <OnFace on="right" at={[x + w, y, z]}>{right}</OnFace> : null}
				{top ? <OnFace on="top" at={[x, y, z + h]}>{top}</OnFace> : null}
				<line x1={G[0]} y1={G[1]} x2={D[0]} y2={edgeEnd} stroke={t.edge} strokeDasharray={dash} opacity={0.75} {...ve} />
			</g>
			<path d={lid} fill="none" stroke={t.edge} strokeDasharray={dash} strokeLinejoin="round" {...ve} />
			<path d={outline} fill="none" stroke={t.edge} strokeDasharray={dash} strokeLinejoin="round" {...ve} />
		</g>
	);
}

/** An upright disc or cylinder centred on (x, y), standing on z. Glass ones
    show the hidden half of their base as a dashed line, like a drawing. */
function Disc({ at, r, h, tone = 'solid', top }: { at: Point; r: number; h: number; tone?: Tone; top?: ReactNode }) {
	const [cx, cy] = pt(at);
	const rx = r * Math.SQRT2 * COS;
	const ry = r * Math.SQRT2 * SIN;
	const t = TONES[tone];
	const side = `M ${fmt(cx - rx)} ${fmt(cy - h)} L ${fmt(cx - rx)} ${fmt(cy)} A ${fmt(rx)} ${fmt(ry)} 0 0 0 ${fmt(cx + rx)} ${fmt(cy)} L ${fmt(cx + rx)} ${fmt(cy - h)}`;
	return (
		<g>
			{tone === 'solid' ? null : (
				<path d={`M ${fmt(cx - rx)} ${fmt(cy)} A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(cx + rx)} ${fmt(cy)}`} stroke={t.edge} strokeDasharray="2 3" opacity={0.6} {...ve} />
			)}
			<path d={`${side} A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(cx - rx)} ${fmt(cy - h)} Z`} fill={t.left} />
			<path d={side} stroke={t.edge} strokeLinejoin="round" {...ve} />
			<ellipse cx={cx} cy={cy - h} rx={rx} ry={ry} fill={t.top} stroke={t.edge} {...ve} />
			{top ? <OnFace on="top" at={[at[0], at[1], at[2] + h]}>{top}</OnFace> : null}
		</g>
	);
}

/** An open box: its inside and rim first, then whatever stands in it, then the
    walls and rim in front. */
function Tray({ at, size, wall, children, left, right }: { at: Point; size: Point; wall: number; children?: ReactNode; left?: ReactNode; right?: ReactNode }) {
	const clip = useSvgId('tray');
	const [x, y, z] = at;
	const [w, d, h] = size;
	const rim = z + h;
	const outer = [pt([x, y, rim]), pt([x + w, y, rim]), pt([x + w, y + d, rim]), pt([x, y + d, rim])];
	const inner = [pt([x + wall, y + wall, rim]), pt([x + w - wall, y + wall, rim]), pt([x + w - wall, y + d - wall, rim]), pt([x + wall, y + d - wall, rim])];
	const floor = z + wall;
	const backWall = [pt([x + wall, y + wall, rim]), pt([x + w - wall, y + wall, rim]), pt([x + w - wall, y + wall, floor]), pt([x + wall, y + wall, floor])];
	const sideWall = [pt([x + wall, y + wall, rim]), pt([x + wall, y + d - wall, rim]), pt([x + wall, y + d - wall, floor]), pt([x + wall, y + wall, floor])];
	const frontLeft = [pt([x, y + d, rim]), pt([x + w, y + d, rim]), pt([x + w, y + d, z]), pt([x, y + d, z])];
	const frontRight = [pt([x + w, y, rim]), pt([x + w, y + d, rim]), pt([x + w, y + d, z]), pt([x + w, y, z])];
	const frame = `M ${pairs(outer).replace(/ /g, ' L ')} Z M ${pairs(inner).replace(/ /g, ' L ')} Z`;
	// The two rim strips nearest the viewer, mitred at the corners: they go over
	// whatever stands in the box, the back strips go under it.
	const frontRim = [pt([x, y + d, rim]), pt([x + w, y + d, rim]), pt([x + w, y, rim]), pt([x + w - wall, y + wall, rim]), pt([x + w - wall, y + d - wall, rim]), pt([x + wall, y + d - wall, rim])];
	return (
		<g>
			<clipPath id={clip}>
				<polygon points={pairs(inner)} />
			</clipPath>
			<polygon points={pairs(inner)} fill={RECESS} />
			<g clipPath={`url(#${clip})`}>
				<polygon points={pairs(backWall)} fill="var(--art-right)" />
				<polygon points={pairs(sideWall)} fill="var(--art-left)" />
			</g>
			<path d={frame} fillRule="evenodd" fill="var(--art-top)" stroke={EDGE} strokeLinejoin="round" {...ve} />
			{children}
			<polygon points={pairs(frontLeft)} fill="var(--art-left)" stroke={EDGE} strokeLinejoin="round" {...ve} />
			<polygon points={pairs(frontRight)} fill="var(--art-right)" stroke={EDGE} strokeLinejoin="round" {...ve} />
			{left ? <OnFace on="left" at={[x, y + d, z]}>{left}</OnFace> : null}
			{right ? <OnFace on="right" at={[x + w, y, z]}>{right}</OnFace> : null}
			<polygon points={pairs(frontRim)} fill="var(--art-top)" stroke={EDGE} strokeLinejoin="round" {...ve} />
		</g>
	);
}

/* ——— Annotation ——— */

/** A dot on the drawing, a dashed leader and a label: the way a technical sheet
    names a part. With rise, the leader climbs first and then runs across. */
function Label({ at, run, rise = 0, accent, children }: { at: Point; run: number; rise?: number; accent?: boolean; children: ReactNode }) {
	const [x0, y0] = pt(at);
	const y1 = y0 + rise;
	const x1 = x0 + run;
	const side = Math.sign(run) || 1;
	const color = accent ? ACCENT : 'var(--text-disabled)';
	const path = rise ? `M ${fmt(x0)} ${fmt(y0)} L ${fmt(x0)} ${fmt(y1)} L ${fmt(x1 - side * 3)} ${fmt(y1)}` : `M ${fmt(x0 + side * 3)} ${fmt(y0)} L ${fmt(x1 - side * 3)} ${fmt(y1)}`;
	return (
		<g>
			<circle cx={x0} cy={y0} r={1.9} fill={color} />
			<path d={path} fill="none" stroke={color} strokeDasharray="2 2.5" {...ve} />
			<text
				x={x1}
				y={y1 + 3.3}
				textAnchor={side > 0 ? 'start' : 'end'}
				fill={accent ? 'var(--accent-text)' : 'var(--text-tertiary)'}
				style={{ font: '500 9.5px var(--font-mono)', letterSpacing: '0.02em' }}
			>
				{children}
			</text>
		</g>
	);
}

/** An arc with an arrowhead, drawn in a face's plane: a turn, or a direction of travel. */
function Turn({ at, r, from, to, stroke = ACCENT }: { at: Pair; r: number; from: number; to: number; stroke?: string }) {
	const rad = (deg: number) => (deg * Math.PI) / 180;
	const p = (deg: number): Pair => [at[0] + r * Math.cos(rad(deg)), at[1] + r * Math.sin(rad(deg))];
	const [sx, sy] = p(from);
	const [ex, ey] = p(to);
	const large = Math.abs(to - from) > 180 ? 1 : 0;
	const sweep = to > from ? 1 : 0;
	const dir = to > from ? 1 : -1;
	const tangent = rad(to) + (dir * Math.PI) / 2;
	const head = 3.2;
	const wing = (offset: number): Pair => [ex - head * Math.cos(tangent + offset), ey - head * Math.sin(tangent + offset)];
	return (
		<g fill="none" stroke={stroke} strokeLinecap="round" strokeLinejoin="round">
			<path d={`M ${fmt(sx)} ${fmt(sy)} A ${r} ${r} 0 ${large} ${sweep} ${fmt(ex)} ${fmt(ey)}`} {...ve} />
			<polyline points={pairs([wing(0.5), [ex, ey], wing(-0.5)])} {...ve} />
		</g>
	);
}

function Frame({ children, label, viewBox, className }: { children: ReactNode; label: string; viewBox: string; className?: string }) {
	return (
		<svg role="img" aria-label={label} viewBox={viewBox} className={cn('h-auto max-w-full overflow-visible', className)} fill="none">
			{children}
		</svg>
	);
}

/* ——— Drawings ——— */

/** A compute unit with a terminal behind its front glass, the cursor blinking:
    a sandbox. The label names its state. */
export function SandboxArt({ className, label = 'idle' }: { className?: string; label?: string }) {
	return (
		<Frame label={`A compute unit with a terminal, ${label}`} viewBox="-104 -50 196 132" className={className}>
			<Block
				at={[0, 0, 0]}
				size={[96, 56, 40]}
				r={4.5}
				top={
					<>
						{[8, 14, 20, 26, 32, 38, 44].map((v) => (
							<Slot key={v} x={8} y={v} w={46} h={3} r={1.5} />
						))}
						<Ring at={[78, 20]} r={8.5} fill={RECESS} stroke={DETAIL} />
						<Ring at={[78, 20]} r={5.5} fill="var(--art-top)" stroke={EDGE} />
						<path d="M 76.2 17.6 A 3 3 0 1 0 79.8 17.6" stroke={EDGE} {...ve} />
						<Ln a={[78, 16]} b={[78, 19.4]} stroke={EDGE} />
						{[66, 72, 78, 84].map((u, i) => (
							<Led key={u} at={[u, 42]} lit={i === 0} r={1.5} />
						))}
					</>
				}
				left={
					<>
						<Slot x={6} y={8} w={54} h={26} r={2.5} edge />
						<Bar x={11} y={28} w={30} />
						<Bar x={11} y={23.5} w={22} />
						<Bar x={11} y={19} w={36} />
						<Trace points={[[11, 15.6], [13.6, 13.8], [11, 12]]} stroke={ACCENT} />
						<rect className="art-blink" x={16} y={11.4} width={4} height={4.8} rx={0.6} fill={ACCENT} />
						{[0, 1, 2, 3, 4, 5, 6].map((i) => (
							<Slot key={i} x={66} y={13 + i * 3} w={22} h={1.6} r={0.8} />
						))}
						<Slot x={66} y={4} w={9.5} h={5} r={1} edge />
						<Slot x={78.5} y={4} w={9.5} h={5} r={1} edge />
						<Bar x={6} y={3.4} w={20} />
					</>
				}
				right={
					<>
						<Slot x={10} y={31} w={36} h={3} r={1.5} />
						<Slot x={8} y={7} w={40} h={18} r={2} edge />
						<Ring at={[16, 16]} r={2.6} fill="var(--art-right)" stroke={EDGE} />
						<Ring at={[25, 16]} r={2.6} fill="var(--art-right)" stroke={EDGE} />
						<Bar x={32} y={15.2} w={10} />
					</>
				}
			/>
			<Label at={[6, 56, 14]} run={-30} accent>
				{label}
			</Label>
		</Frame>
	);
}

/** A circuit board: the main bus with its chip, and a trace that branches off to
    a second chip lit in cyan. A branch on its way to a pull request. */
export function BranchArt({ className }: { className?: string }) {
	const pins = (x: number, y: number, s: number, stroke = DETAIL) => (
		<>
			{[0.2, 0.36, 0.52, 0.68, 0.84].map((k) => (
				<g key={k}>
					<Ln a={[x + s * k, y + s]} b={[x + s * k, y + s + 3]} stroke={stroke} />
					<Ln a={[x + s, y + s * k]} b={[x + s + 3, y + s * k]} stroke={stroke} />
					<Ln a={[x + s * k, y - 3]} b={[x + s * k, y]} stroke={stroke} />
					<Ln a={[x - 3, y + s * k]} b={[x, y + s * k]} stroke={stroke} />
				</g>
			))}
		</>
	);
	return (
		<Frame label="A circuit board with a branch trace to a lit chip" viewBox="-122 -38 268 156" className={className}>
			<Block
				at={[0, 0, 0]}
				size={[150, 80, 5]}
				r={3}
				top={
					<>
						{(
							[
								[6, 6],
								[144, 6],
								[6, 74],
								[144, 74],
							] as Pair[]
						).map((p) => (
							<Ring key={p.join()} at={p} r={2.4} fill={RECESS} stroke={DETAIL} />
						))}
						<Ln a={[6, 63]} b={[144, 63]} />
						<Ln a={[6, 67]} b={[144, 67]} />
						<Ln a={[6, 71]} b={[144, 71]} />
						<Trace points={[[24, 57], [24, 63]]} />
						<Trace points={[[31, 57], [31, 67]]} />
						<Trace points={[[38, 57], [38, 71]]} />
						{pins(14, 20, 34)}
						{pins(96, 20, 30, ACCENT)}
						<Trace points={[[68, 63], [68, 35], [93, 35]]} stroke={ACCENT} />
						<Ring at={[68, 63]} r={1.8} fill={ACCENT} stroke={ACCENT} />
						<Ring at={[68, 35]} r={1.6} fill="var(--art-top)" stroke={ACCENT} />
						<Bar x={100} y={58} w={30} />
						<Bar x={100} y={54} w={18} />
						<Trace points={[[132, 20], [132, 12], [104, 12], [104, 17]]} />
					</>
				}
			/>
			<Block at={[62, 6, 5]} size={[12, 5, 3]} r={1} />
			<Block at={[80, 6, 5]} size={[12, 5, 3]} r={1} />
			<Block
				at={[14, 20, 5]}
				size={[34, 34, 6]}
				r={2}
				top={
					<>
						<Ring at={[6, 6]} r={2} fill={RECESS} stroke={DETAIL} />
						<Bar x={8} y={20} w={18} />
						<Bar x={8} y={24} w={11} />
					</>
				}
			/>
			<Block
				at={[96, 20, 5]}
				size={[30, 30, 8]}
				r={2}
				tone="accent"
				top={
					<>
						<Ring at={[5.5, 5.5]} r={1.8} fill="var(--art-accent-right)" stroke={ACCENT} />
						<Bar x={7} y={17} w={16} accent />
						<Bar x={7} y={21} w={9} accent />
					</>
				}
			/>
			<Disc
				at={[136, 44, 5]}
				r={5}
				h={9}
				top={
					<>
						<Ln a={[-2.5, 0]} b={[2.5, 0]} stroke={EDGE} />
						<Ln a={[0, -2.5]} b={[0, 2.5]} stroke={EDGE} />
					</>
				}
			/>
			<Label at={[14, 54, 9]} run={-48}>
				main
			</Label>
			<Label at={[126, 22, 13]} run={18} accent>
				anton/…
			</Label>
		</Frame>
	);
}

/** An exploded drive: platters lifted apart along their axis, one for each
    thing storage keeps, the checkpoint layer lit. */
export function StorageArt({ className }: { className?: string }) {
	const R = 26;
	const rim = (z: number): Point => [R / Math.SQRT2, -R / Math.SQRT2, z];
	const platter = (accent?: boolean) => {
		const stroke = accent ? ACCENT : DETAIL;
		return (
			<>
				<Ring at={[0, 0]} r={20} stroke={stroke} />
				<Ring at={[0, 0]} r={9} stroke={stroke} />
				<Ring at={[0, 0]} r={3.2} fill={RECESS} stroke={accent ? ACCENT : EDGE} />
				{accent ? <Turn at={[0, 0]} r={14.5} from={-150} to={-40} /> : null}
			</>
		);
	};
	const [ax0, ay0] = pt([0, 0, -6]);
	const [, ay1] = pt([0, 0, 104]);
	return (
		<Frame label="An exploded stack of storage platters, the checkpoint layer lit" viewBox="-44 -120 168 148" className={className}>
			<line x1={ax0} y1={ay0} x2={ax0} y2={ay1} stroke={DETAIL} strokeDasharray="7 3 1.5 3" {...ve} />
			<Disc
				at={[0, 0, 0]}
				r={R}
				h={9}
				top={
					<>
						<Ring at={[0, 0]} r={21.5} stroke={DETAIL} />
						<Ring at={[0, 0]} r={6} fill={RECESS} stroke={DETAIL} />
						{[45, 135, 225, 315].map((deg) => (
							<Ring key={deg} at={[23.8 * Math.cos((deg * Math.PI) / 180), 23.8 * Math.sin((deg * Math.PI) / 180)]} r={1.1} fill={DETAIL} stroke="none" />
						))}
					</>
				}
			/>
			<Disc at={[0, 0, 34]} r={R} h={3} tone="glass" top={platter()} />
			<Disc at={[0, 0, 62]} r={R} h={3} tone="accent" top={platter(true)} />
			<Disc at={[0, 0, 90]} r={R} h={3} tone="glass" top={platter()} />
			<Label at={rim(91.5)} run={16}>
				library
			</Label>
			<Label at={rim(63.5)} run={16} accent>
				checkpoints
			</Label>
			<Label at={rim(35.5)} run={16}>
				diffs
			</Label>
		</Frame>
	);
}

/** A card file with one card drawn up out of its slot and lit: the next task. */
export function TasksArt({ className }: { className?: string }) {
	const card = (y: number, tab: number, lift = 0, accent?: boolean) => (
		<g key={y}>
			<Block
				at={[8, y, 4 + lift]}
				size={[74, 2, 38]}
				r={1.5}
				tone={accent ? 'accent' : 'solid'}
				left={
					accent ? (
						<>
							<rect x={6} y={27} width={6} height={6} rx={1.4} fill="none" stroke={ACCENT} {...ve} />
							<Trace points={[[7.4, 30.2], [8.8, 28.6], [11, 31.6]]} stroke={ACCENT} />
							<Bar x={16} y={30.6} w={34} accent />
							<Bar x={16} y={26} w={22} accent />
							<Bar x={6} y={18} w={50} accent />
							<Bar x={6} y={13.4} w={40} accent />
						</>
					) : (
						<>
							<Bar x={6} y={33} w={30} />
							<Bar x={6} y={28.6} w={18} />
						</>
					)
				}
			/>
			<Block at={[8 + tab, y, 42 + lift]} size={[16, 2, 5]} r={1.2} tone={accent ? 'accent' : 'solid'} />
		</g>
	);
	return (
		<Frame label="A card file with one card drawn up" viewBox="-74 -82 186 156" className={className}>
			<Tray
				at={[0, 0, 0]}
				size={[90, 64, 30]}
				wall={3}
				left={
					<>
						<Slot x={33} y={15} w={24} h={8} r={1.2} edge />
						<Bar x={37} y={18.2} w={16} />
						<Ring at={[45, 8.5]} r={2.8} fill={RECESS} stroke={EDGE} />
					</>
				}
				right={
					<>
						<Bar x={10} y={22} w={20} />
						<Bar x={10} y={18} w={12} />
					</>
				}
			>
				{card(12, 4)}
				{card(22, 22)}
				{card(34, 40, 30, true)}
				{card(44, 52)}
				{card(54, 14)}
			</Tray>
			<Label at={[82, 36, 64]} run={14} accent>
				next
			</Label>
		</Frame>
	);
}

/** A switch with a row of ports and a plug about to go into one, lit: a
    preview port waiting to be added. */
export function LinkArt({ className }: { className?: string }) {
	const plugBack = pt([66, 72, 11]);
	const c1 = pt([66, 88, 11]);
	const c2 = pt([60, 104, 0]);
	const end = pt([36, 116, 0]);
	const cable = `M ${fmt(plugBack[0])} ${fmt(plugBack[1])} C ${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(end[0])} ${fmt(end[1])}`;
	return (
		<Frame label="A row of ports with a plug lined up to one" viewBox="-112 -34 236 128" className={className}>
			<Block
				at={[0, 0, 0]}
				size={[130, 44, 22]}
				r={4}
				top={
					<>
						{Array.from({ length: 9 }, (_, i) => (
							<Slot key={i} x={10 + i * 8} y={8} w={3.2} h={16} r={1.6} />
						))}
						<Slot x={90} y={22} w={32} h={14} r={2} edge />
						<Led at={[97, 29]} lit />
						<Led at={[104, 29]} />
						<Led at={[111, 29]} />
						<Bar x={10} y={33} w={34} />
					</>
				}
				left={
					<>
						{[0, 1, 2, 3].map((i) => (
							<g key={i}>
								<rect x={8 + i * 24} y={5} width={17} height={11} rx={1.6} fill={i === 2 ? 'var(--art-accent-right)' : RECESS} stroke={i === 2 ? ACCENT : DETAIL} {...ve} />
								{[0, 1, 2, 3].map((k) => (
									<Bar key={k} x={10.5 + i * 24 + k * 3.4} y={13} w={1.6} h={1.6} accent={i === 2} />
								))}
							</g>
						))}
						<Led at={[110, 12]} lit />
						<Led at={[116, 12]} />
						<Bar x={104} y={6} w={18} />
					</>
				}
				right={
					<>
						<Slot x={12} y={6} w={20} h={11} r={2} edge />
						<Bar x={16} y={11} w={2} h={3} />
						<Bar x={21} y={11} w={2} h={3} />
						<Bar x={26} y={11} w={2} h={3} />
					</>
				}
			/>
			<Trace points={[pt([62, 50, 8]), pt([62, 44, 8])]} stroke={ACCENT} dash="2 2.5" />
			<Trace points={[pt([70, 50, 15]), pt([70, 44, 15])]} stroke={ACCENT} dash="2 2.5" />
			<path d={cable} stroke={EDGE} strokeWidth={6} strokeLinecap="round" />
			<path d={cable} stroke="var(--art-left)" strokeWidth={4.2} strokeLinecap="round" />
			<Block at={[61, 50, 7.5]} size={[10, 8, 7]} r={1} tone="accent" />
			<Block
				at={[59, 58, 5.5]}
				size={[14, 14, 11]}
				r={2}
				left={
					<>
						<Bar x={3} y={4} w={8} />
						<Bar x={3} y={7} w={8} />
					</>
				}
			/>
			<Label at={[59, 66, 11]} run={-34} accent>
				:3000
			</Label>
		</Frame>
	);
}

/** A tape deck with a fresh cassette, its counter at zero and the record key
    lit: checkpoints, waiting for the first one. */
export function HistoryArt({ className }: { className?: string }) {
	const reel = (at: Pair, spool: number) => (
		<>
			<Ring at={at} r={spool} fill="var(--art-left)" stroke={DETAIL} />
			<Ring at={at} r={4.2} fill="var(--art-top)" stroke={EDGE} />
			{[0, 60, 120, 180, 240, 300].map((deg) => {
				const a = (deg * Math.PI) / 180;
				return <Ln key={deg} a={[at[0] + 2 * Math.cos(a), at[1] + 2 * Math.sin(a)]} b={[at[0] + 3.6 * Math.cos(a), at[1] + 3.6 * Math.sin(a)]} stroke={EDGE} />;
			})}
		</>
	);
	return (
		<Frame label="A tape deck with its counter at zero" viewBox="-80 -44 214 128" className={className}>
			<Block
				at={[0, 0, 0]}
				size={[110, 70, 16]}
				r={4}
				top={<Slot x={8} y={8} w={74} h={54} r={3} edge />}
				left={
					<>
						<Slot x={8} y={4} w={26} h={8} r={1.4} edge />
						<Print at={[11.5, 5.8]}>000</Print>
						<Led at={[42, 8]} lit r={1.6} />
						{[0, 1, 2, 3, 4].map((i) => (
							<Slot key={i} x={62 + i * 8} y={5} w={4} h={6} r={1} />
						))}
					</>
				}
				right={
					<>
						<Ring at={[14, 8]} r={2.6} fill={RECESS} stroke={DETAIL} />
						<Ring at={[24, 8]} r={2.6} fill={RECESS} stroke={DETAIL} />
						<Bar x={34} y={7.2} w={24} />
					</>
				}
			/>
			<Block
				at={[12, 12, 16]}
				size={[66, 46, 4]}
				r={3}
				top={
					<>
						{reel([20, 18], 9.5)}
						{reel([46, 18], 5.4)}
						<Ln a={[20, 27.5]} b={[46, 23.4]} stroke={DETAIL} />
						<Slot x={6} y={31} w={54} h={10} r={1.5} edge />
						<Bar x={10} y={34.6} w={30} />
						<Turn at={[46, 18]} r={12} from={150} to={30} />
					</>
				}
			/>
			<Block at={[88, 12, 16]} size={[16, 12, 3]} r={1.5} />
			<Block at={[88, 28, 16]} size={[16, 12, 3]} r={1.5} tone="accent" top={<Led at={[8, 6]} lit r={1.8} />} />
			<Block at={[88, 44, 16]} size={[16, 12, 3]} r={1.5} />
			<Label at={[104, 34, 19]} run={22} accent>
				rec
			</Label>
		</Frame>
	);
}

/** A filing cabinet with its top drawer pulled out and one folder lifted and
    lit: reports and screenshots the agent kept. */
export function LibraryArt({ className }: { className?: string }) {
	const folder = (y: number, tab: number, lift = 0, accent?: boolean) => (
		<g key={y}>
			<Block
				at={[10, y, 46 + lift]}
				size={[52, 1.6, 22]}
				r={1.2}
				tone={accent ? 'accent' : 'solid'}
				left={accent ? <Bar x={5} y={16} w={26} accent /> : <Bar x={5} y={17} w={20} />}
			/>
			<Block at={[10 + tab, y, 68 + lift]} size={[13, 1.6, 4.5]} r={1} tone={accent ? 'accent' : 'solid'} />
		</g>
	);
	return (
		<Frame label="A filing cabinet with a drawer pulled out and one folder lifted" viewBox="-124 -94 222 168" className={className}>
			<Block
				at={[0, 0, 0]}
				size={[72, 58, 78]}
				r={4}
				left={
					<>
						<rect x={5} y={5} width={62} height={32} rx={2} fill="none" stroke={EDGE} {...ve} />
						<Slot x={26} y={24} w={20} h={7} r={1} edge />
						<Bar x={29} y={26.8} w={14} />
						<Slot x={28} y={11} w={16} h={3} r={1.5} />
						<Slot x={5} y={41} w={62} h={32} r={2} />
					</>
				}
				right={
					<>
						<Ln a={[6, 39]} b={[52, 39]} />
						<Bar x={8} y={8} w={14} />
					</>
				}
				top={
					<>
						<Bar x={8} y={8} w={22} />
						<Bar x={8} y={12} w={14} />
					</>
				}
			/>
			<Tray at={[7, 58, 43]} size={[58, 34, 26]} wall={2.5}>
				{folder(63, 4)}
				{folder(70, 34)}
				{folder(77, 20, 16, true)}
				{folder(84, 8)}
			</Tray>
			<Block
				at={[5, 92, 41]}
				size={[62, 3, 31]}
				r={2}
				left={
					<>
						<Slot x={21} y={19} w={20} h={7} r={1} edge />
						<Bar x={24} y={21.8} w={14} />
						<Slot x={23} y={7} w={16} h={3} r={1.5} />
					</>
				}
			/>
			<Label at={[30, 78.6, 86]} run={-46} rise={-26} accent>
				saved
			</Label>
		</Frame>
	);
}

/** Where each station of the task route stands, in screen units across a 400-wide
    drawing: the centres of four equal columns, so captions laid out in a
    four-column grid under it line up with the stations. */
const ROUTE_X = [50, 150, 250, 350];
/** Half a station's footprint: on screen its side corners sit this far times
    √3 either side of the centre, on the ground line. */
const HALF = 20;
const SIDE = HALF * 2 * COS;

/** The grid point under a station: along x and against y at once, so stations
    side by side on screen sit in one row. */
const stationAt = (column: number): Pair => {
	const t = ROUTE_X[column] / (2 * COS);
	return [t, -t];
};

/** A station's block, centred on its column. */
function Station(props: Omit<Parameters<typeof Block>[0], 'at' | 'size'> & { column: number; h: number }) {
	const { column, h, ...rest } = props;
	const [cx, cy] = stationAt(column);
	return <Block at={[cx - HALF, cy - HALF, 0]} size={[HALF * 2, HALF * 2, h]} {...rest} />;
}

/** Shown only while its stage is the active one; the stages take turns (see
    .route-lit in instrument.css). The first stage is the one shown when motion
    is reduced. */
function Lit({ stage, children }: { stage: number; children: ReactNode }) {
	return (
		<g className="route-lit" data-first={stage === 0 || undefined} style={{ '--stage': stage } as CSSProperties}>
			{children}
		</g>
	);
}

/** A line drawn on as its stage begins, by a dash as long as the whole path. */
const drawOn = (stage: number) => ({
	className: 'route-draw',
	pathLength: 1,
	// pathLength dashes are measured along the drawn path; a non-scaling stroke would measure them on screen instead.
	vectorEffect: 'none' as const,
	style: { '--stage': stage } as CSSProperties,
});

/** The ground line from one station to the next, with the hand-off: a cyan trail
    runs along it and a dot rides its head as one stage passes to the next. */
function Handoff({ from }: { from: number }) {
	const x1 = ROUTE_X[from] + SIDE;
	const x2 = ROUTE_X[from + 1] - SIDE;
	const vars = { '--stage': from, '--run': x2 - x1 - 6 } as CSSProperties;
	return (
		<g>
			<line x1={x1 + 3} y1={0} x2={x2 - 3} y2={0} stroke={EDGE} strokeDasharray="2 3" {...ve} />
			<circle cx={x1 + 3} cy={0} r={1.6} fill={EDGE} />
			<circle cx={x2 - 3} cy={0} r={1.6} fill={EDGE} />
			<line className="route-trail" x1={x1 + 3} y1={0} x2={x2 - 3} y2={0} pathLength={1} stroke={ACCENT} strokeWidth={1.2} style={vars} />
			<circle className="route-dot" cx={x1 + 3} cy={0} r={2.6} fill="var(--cyan-200)" style={vars} />
		</g>
	);
}

/**
 * How a task runs, as four stations on one ground line. The stages take turns:
 * each lights up cyan and does its work, then hands off along the line to the
 * next. The reader sweeps the repository's snapshot, the branch box draws its
 * fork, the sandbox boots out of its dashed outline with a cursor, and the pull
 * request is sealed with a check. Captions laid out under it can follow along
 * with .route-caption.
 */
export function TaskRouteArt({ className }: { className?: string }) {
	const [rx, ry] = stationAt(0);
	const sheets = [26, 31, 36];
	const readTop = (lit: boolean) => (
		<>
			<Slot x={6} y={6} w={28} h={28} r={2.5} />
			{(
				[
					[10, 11, 16],
					[10, 15, 10],
					[13, 19, 14],
					[13, 23, 8],
					[10, 27, 12],
				] as const
			).map(([x, y, w]) => (
				<Bar key={y} x={x} y={y} w={w} accent={lit} />
			))}
			{lit ? (
				<g className="art-scan">
					<line x1={7} y1={8} x2={33} y2={8} stroke="var(--cyan-100)" strokeWidth={1.4} {...ve} />
				</g>
			) : null}
		</>
	);
	const fork = (lit: boolean, stage: number) => {
		const stroke = lit ? ACCENT : EDGE;
		const fill = lit ? 'var(--art-accent-top)' : 'var(--art-top)';
		return (
			<>
				<Slot x={5} y={5} w={30} h={30} r={2.5} edge />
				<Ln a={[12, 12.6]} b={[12, 27.4]} stroke={stroke} />
				<path d="M 28 14.6 C 28 21 12 18.5 12 24.4" fill="none" stroke={stroke} {...ve} {...(lit ? drawOn(stage) : {})} />
				<Ring at={[12, 10]} r={2.6} stroke={stroke} fill={fill} />
				<Ring at={[12, 30]} r={2.6} stroke={stroke} fill={fill} />
				<Ring at={[28, 12]} r={2.6} stroke={stroke} fill={lit ? 'var(--cyan-300)' : fill} />
			</>
		);
	};
	const merge = (lit: boolean) => {
		const stroke = lit ? ACCENT : EDGE;
		const fill = lit ? 'var(--art-accent-top)' : 'var(--art-top)';
		return (
			<>
				<Slot x={5} y={5} w={30} h={30} r={2.5} edge />
				<Ring at={[12, 10]} r={2.6} stroke={stroke} fill={fill} />
				<Ring at={[12, 30]} r={2.6} stroke={stroke} fill={fill} />
				<Ring at={[28, 30]} r={2.6} stroke={stroke} fill={fill} />
				<Ln a={[12, 12.6]} b={[12, 27.4]} stroke={stroke} />
				<Trace points={[[28, 27.4], [28, 17], [21, 11.2]]} stroke={stroke} />
				<Trace points={[[23.6, 10.4], [21, 11.2], [21.6, 13.8]]} stroke={stroke} />
			</>
		);
	};
	return (
		<Frame label="A task's route: read, branch, sandbox, pull request" viewBox="0 -64 400 90" className={className}>
			<line x1={0} y1={0} x2={ROUTE_X[0] - SIDE - 3} y2={0} stroke={DETAIL} strokeDasharray="2 3" {...ve} />
			<line x1={ROUTE_X[3] + SIDE + 3} y1={0} x2={400} y2={0} stroke={DETAIL} strokeDasharray="2 3" {...ve} />
			<Handoff from={0} />
			<Handoff from={1} />
			<Handoff from={2} />

			{/* 01 Read: the reader sweeps the snapshot that hangs above it. */}
			<Station column={0} h={16} r={3.5} top={readTop(false)} left={<Led at={[6, 11]} />} />
			<Lit stage={0}>
				<Station column={0} h={16} r={3.5} tone="accent" top={readTop(true)} left={<Led at={[6, 11]} lit />} />
				{(
					[
						[-13, 15],
						[13, 15],
						[13, -15],
					] as const
				).map(([dx, dy]) => (
					<Trace key={`${dx}${dy}`} points={[pt([rx + dx, ry + dy, 16]), pt([rx + dx, ry + dy, 26])]} stroke={ACCENT} dash="1.5 2.5" />
				))}
			</Lit>
			{sheets.map((z, i) => (
				<Block
					key={z}
					at={[rx - 13, ry - 15, z]}
					size={[26, 30, 1.2]}
					r={1.2}
					tone={i === sheets.length - 1 ? 'solid' : 'glass'}
					top={
						i === sheets.length - 1 ? (
							<>
								<Bar x={4} y={5} w={12} />
								<Bar x={7} y={9} w={11} />
								<Bar x={7} y={13} w={14} />
								<Bar x={4} y={17} w={9} />
								<Bar x={4} y={21} w={16} />
							</>
						) : undefined
					}
				/>
			))}

			{/* 02 Branch: the fork in its lid draws itself. */}
			<Station column={1} h={18} r={3.5} top={fork(false, 1)} left={<Led at={[33, 13]} />} />
			<Lit stage={1}>
				<Station column={1} h={18} r={3.5} tone="accent" top={fork(true, 1)} left={<Led at={[33, 13]} lit />} />
			</Lit>

			{/* 03 Sandbox: a dashed outline until it is needed, then it boots. */}
			<Station
				column={2}
				h={30}
				r={4}
				tone="glass"
				dashed
				top={[8, 13, 18, 23].map((v) => (
					<Ln key={v} a={[7, v]} b={[25, v]} />
				))}
				left={<rect x={5} y={12} width={30} height={13} rx={2} fill="none" stroke={DETAIL} strokeDasharray="2 2" {...ve} />}
			/>
			<Lit stage={2}>
				<Station
					column={2}
					h={30}
					r={4}
					tone="accent"
					top={
						<>
							{[8, 13, 18, 23].map((v) => (
								<Slot key={v} x={7} y={v} w={18} h={2.4} r={1.2} />
							))}
							<Led at={[31, 30]} lit r={1.8} />
						</>
					}
					left={
						<>
							<Slot x={5} y={12} w={30} h={13} r={2} edge />
							<Trace points={[[8.5, 20], [10.6, 18.6], [8.5, 17.2]]} stroke={ACCENT} />
							<rect className="art-blink" x={12} y={16.6} width={3} height={3.6} rx={0.5} fill={ACCENT} />
							<Bar x={8} y={22} w={16} accent />
						</>
					}
					right={[6, 10, 14].map((v) => (
						<Slot key={v} x={8} y={v} w={24} h={1.8} r={0.9} />
					))}
				/>
			</Lit>

			{/* 04 Pull request: the case is sealed with a check. */}
			<Station column={3} h={22} r={3.5} top={merge(false)} left={<Slot x={27} y={13} w={10} h={5} r={1} edge />} />
			<Lit stage={3}>
				<Station
					column={3}
					h={22}
					r={3.5}
					tone="accent"
					top={merge(true)}
					left={
						<>
							<Slot x={27} y={13} w={10} h={5} r={1} edge />
							<polyline points="29,15.4 30.4,14.2 33,16.8" fill="none" stroke="var(--cyan-200)" strokeLinecap="round" strokeLinejoin="round" {...ve} {...drawOn(3)} />
							<Led at={[6, 15.5]} lit />
						</>
					}
				/>
			</Lit>
		</Frame>
	);
}

/** Anton's mark: an isometric cube on a cyan tile. */
export function Logo({ size = 20 }: { size?: number }) {
	const id = `anton-mark${useId().replace(/[^\w-]/g, '')}`;
	return (
		<svg aria-hidden width={size} height={size} viewBox="0 0 20 20" className="shrink-0">
			<defs>
				<linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor="var(--cyan-300)" />
					<stop offset="1" stopColor="var(--cyan-600)" />
				</linearGradient>
			</defs>
			<rect width="20" height="20" rx="5.5" fill={`url(#${id})`} />
			<g fill="none" stroke="var(--accent-fg)" strokeWidth="1.3" strokeLinejoin="round">
				<path d="M10 4.6 15 7.4V12.6L10 15.4 5 12.6V7.4Z" />
				<path d="M5 7.4 10 10.2 15 7.4M10 10.2V15.4" />
			</g>
		</svg>
	);
}
