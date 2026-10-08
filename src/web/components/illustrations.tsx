import { createContext, type ReactNode, useContext, useId } from 'react';

/* Isometric drawings for empty and quiet states. Each one is a small device
   built from boxes and cylinders in a 3D grid, projected at 30° so they share
   one perspective. Faces are shaded, edges catch light, and the details (vents,
   screens, dials, LEDs) are drawn in each face's own 2D plane, so they follow
   the surface they sit on. One lit cyan part carries the meaning. */

type Point = [number, number, number];
type Pair = [number, number];

const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;
/** A circle of radius r on the ground plane projects to an ellipse this wide and tall. */
const ELLIPSE_X = Math.SQRT2 * COS;
const ELLIPSE_Y = Math.SQRT2 * SIN;

const pt = ([x, y, z]: Point): Pair => [(x - y) * COS, (x + y) * SIN - z];
const fmt = (n: number) => n.toFixed(2);
const project = (p: Point) => pt(p).map(fmt).join(',');
const poly = (points: Point[]) => points.map(project).join(' ');

const ArtId = createContext('art');
const ve = { vectorEffect: 'non-scaling-stroke' } as const;

/* ——— Surfaces ——— */

type Plane = 'left' | 'right' | 'top';

/** Where a plane's local axes (u across, v up or back) land on screen. */
const AXES: Record<Plane, [number, number, number, number]> = {
	left: [COS, SIN, 0, -1],
	right: [-COS, SIN, 0, -1],
	top: [COS, SIN, -COS, SIN],
};

/** Draws its children in the 2D plane of a face, with the origin at a grid point. */
function OnFace({ on, at, children }: { on: Plane; at: Point; children: ReactNode }) {
	const [ox, oy] = pt(at);
	return <g transform={`matrix(${AXES[on].map(fmt).join(' ')} ${fmt(ox)} ${fmt(oy)})`}>{children}</g>;
}

type Ink = { accent?: boolean; dim?: boolean; dash?: string };
const ink = ({ accent, dim }: Ink) => (accent ? 'var(--accent-base)' : dim ? 'var(--line-art-faint)' : 'var(--line-art)');

/** A line in a face's plane. */
function Ln({ a, b, ...s }: Ink & { a: Pair; b: Pair }) {
	return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={ink(s)} strokeDasharray={s.dash} {...ve} />;
}

function Trace({ points, ...s }: Ink & { points: Pair[] }) {
	return <polyline points={points.map((p) => p.join(',')).join(' ')} fill="none" stroke={ink(s)} strokeDasharray={s.dash} strokeLinejoin="round" {...ve} />;
}

function Rc({ x, y, w, h, r = 0, fill, ...s }: Ink & { x: number; y: number; w: number; h: number; r?: number; fill?: string }) {
	return <rect x={x} y={y} width={w} height={h} rx={r} fill={fill ?? 'none'} stroke={ink(s)} strokeDasharray={s.dash} {...ve} />;
}

function Ring({ at, r, fill, ...s }: Ink & { at: Pair; r: number; fill?: string }) {
	return <circle cx={at[0]} cy={at[1]} r={r} fill={fill ?? 'none'} stroke={ink(s)} strokeDasharray={s.dash} {...ve} />;
}

/** A status light: lit ones are cyan, with a soft halo. */
function Led({ at, lit, r = 1.3 }: { at: Pair; lit?: boolean; r?: number }) {
	return (
		<g>
			{lit ? <circle cx={at[0]} cy={at[1]} r={r * 2.6} fill="var(--accent-base)" opacity={0.2} /> : null}
			<circle cx={at[0]} cy={at[1]} r={r} fill={lit ? 'var(--cyan-200)' : 'var(--line-art-faint)'} />
		</g>
	);
}

/** Parallel vent slots. */
function Vents({ x, y, w, n, gap }: { x: number; y: number; w: number; n: number; gap: number }) {
	return (
		<g>
			{Array.from({ length: n }, (_, i) => (
				<Ln key={i} a={[x, y + i * gap]} b={[x + w, y + i * gap]} dim />
			))}
		</g>
	);
}

/** Lines of text, as short filled bars. */
function Bars({ x, y, widths, gap = 4, accent }: { x: number; y: number; widths: number[]; gap?: number; accent?: boolean }) {
	return (
		<g fill={accent ? 'var(--cyan-200)' : 'var(--line-art-faint)'} opacity={accent ? 0.9 : 1}>
			{widths.map((w, i) => (
				<rect key={i} x={x} y={y - i * gap} width={w} height={1.6} rx={0.8} />
			))}
		</g>
	);
}

/** A glow on the ground plane. */
function Glow({ at, r }: { at: Point; r: number }) {
	const id = useContext(ArtId);
	return (
		<OnFace on="top" at={at}>
			<circle r={r} fill={`url(#${id}-glow)`} />
		</OnFace>
	);
}

/* ——— Solids ——— */

type Details = { left?: ReactNode; right?: ReactNode; top?: ReactNode };

/** A box's three visible faces, from its near corner at (x, y, z). */
function boxFaces(x: number, y: number, z: number, w: number, d: number, h: number): Record<Plane, string> {
	return {
		top: poly([
			[x, y, z + h],
			[x + w, y, z + h],
			[x + w, y + d, z + h],
			[x, y + d, z + h],
		]),
		left: poly([
			[x, y + d, z + h],
			[x + w, y + d, z + h],
			[x + w, y + d, z],
			[x, y + d, z],
		]),
		right: poly([
			[x + w, y, z + h],
			[x + w, y + d, z + h],
			[x + w, y + d, z],
			[x + w, y, z],
		]),
	};
}

function Box({
	at,
	size,
	accent,
	dashed,
	ghost,
	bezel,
	left,
	right,
	top,
}: Details & { at: Point; size: Point; accent?: boolean; dashed?: boolean; ghost?: boolean; bezel?: number }) {
	const id = useContext(ArtId);
	const [x, y, z] = at;
	const [w, d, h] = size;
	const faces = boxFaces(x, y, z, w, d, h);
	const tone = accent ? 'acc' : 'dark';
	const fill = (face: Plane) => (ghost ? 'none' : `url(#${id}-${tone}-${face})`);
	const stroke = accent ? 'var(--accent-base)' : 'var(--line-art)';
	const dash = dashed ? '3 3' : undefined;
	const rim = accent ? 'var(--cyan-200)' : 'var(--line-art-hi)';
	return (
		<g strokeLinejoin="round" strokeLinecap="round">
			<polygon points={faces.left} fill={fill('left')} stroke={stroke} strokeDasharray={dash} {...ve} />
			<polygon points={faces.right} fill={fill('right')} stroke={stroke} strokeDasharray={dash} {...ve} />
			<polygon points={faces.top} fill={fill('top')} stroke={stroke} strokeDasharray={dash} {...ve} />
			{ghost ? null : (
				<>
					<polyline
						points={poly([
							[x, y + d, z + h],
							[x + w, y + d, z + h],
							[x + w, y, z + h],
						])}
						fill="none"
						stroke={rim}
						{...ve}
					/>
					<polyline
						points={poly([
							[x + w, y + d, z + h],
							[x + w, y + d, z],
						])}
						fill="none"
						stroke={rim}
						opacity={0.5}
						{...ve}
					/>
				</>
			)}
			{bezel ? (
				<OnFace on="top" at={[x, y, z + h]}>
					<Rc x={bezel} y={bezel} w={w - bezel * 2} h={d - bezel * 2} accent={accent} dim />
				</OnFace>
			) : null}
			{left ? <OnFace on="left" at={[x, y + d, z]}>{left}</OnFace> : null}
			{right ? <OnFace on="right" at={[x + w, y, z]}>{right}</OnFace> : null}
			{top ? <OnFace on="top" at={[x, y, z + h]}>{top}</OnFace> : null}
		</g>
	);
}

/** An upright cylinder standing on (x, y, z). */
function Cylinder({ at, r, h, accent, children }: { at: Point; r: number; h: number; accent?: boolean; children?: ReactNode }) {
	const id = useContext(ArtId);
	const [cx, cy] = pt(at);
	const rx = r * ELLIPSE_X;
	const ry = r * ELLIPSE_Y;
	const stroke = accent ? 'var(--accent-base)' : 'var(--line-art)';
	return (
		<g strokeLinejoin="round">
			<path
				d={`M ${fmt(cx - rx)} ${fmt(cy - h)} V ${fmt(cy)} A ${fmt(rx)} ${fmt(ry)} 0 0 0 ${fmt(cx + rx)} ${fmt(cy)} V ${fmt(cy - h)} Z`}
				fill={`url(#${id}-${accent ? 'cylA' : 'cyl'})`}
				stroke={stroke}
				{...ve}
			/>
			<ellipse cx={cx} cy={cy - h} rx={rx} ry={ry} fill={`url(#${id}-${accent ? 'acc' : 'dark'}-top)`} stroke={accent ? 'var(--cyan-200)' : 'var(--line-art-hi)'} {...ve} />
			{children ? <OnFace on="top" at={[at[0], at[1], at[2] + h]}>{children}</OnFace> : null}
		</g>
	);
}

/** A line between two grid points, dashed by default. */
function Path({ from, to, accent, solid, width = 1 }: { from: Point; to: Point; accent?: boolean; solid?: boolean; width?: number }) {
	const [x1, y1] = pt(from);
	const [x2, y2] = pt(to);
	return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={accent ? 'var(--accent-base)' : 'var(--line-art-faint)'} strokeWidth={width} strokeDasharray={solid ? undefined : '3 4'} strokeLinecap="round" {...ve} />;
}

/** A small mono tag stuck on the drawing, like the labels on a technical diagram. */
function Tag({ at, children }: { at: Point; children: ReactNode }) {
	const [x, y] = pt(at);
	return (
		<g transform={`translate(${fmt(x)} ${fmt(y)})`}>
			<rect x={-2} y={-9} width={String(children).length * 6.2 + 10} height={14} rx={3} fill="var(--bg-overlay)" stroke="var(--line-art-faint)" />
			<text x={3} y={1} fill="var(--text-tertiary)" style={{ font: '500 8.5px var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
				{children}
			</text>
		</g>
	);
}

/** An isometric grid on the ground that fades out toward its edges. */
function Floor({ at, cells = 7, step = 16 }: { at: Pair; cells?: number; step?: number }) {
	const id = useContext(ArtId);
	const [cx, cy] = at;
	const span = cells * step;
	const lines: ReactNode[] = [];
	const seg = (key: string, a: Point, b: Point) => {
		const [x1, y1] = pt(a);
		const [x2, y2] = pt(b);
		lines.push(<line key={key} x1={fmt(x1)} y1={fmt(y1)} x2={fmt(x2)} y2={fmt(y2)} />);
	};
	for (let i = -cells; i <= cells; i++) {
		const o = i * step;
		seg(`x${i}`, [cx + o, cy - span, 0], [cx + o, cy + span, 0]);
		seg(`y${i}`, [cx - span, cy + o, 0], [cx + span, cy + o, 0]);
	}
	const [sx, sy] = pt([cx, cy, 0]);
	const rx = span * COS * 0.95;
	return (
		<g>
			<mask id={`${id}-floor`}>
				<ellipse cx={sx} cy={sy} rx={rx} ry={rx * 0.62} fill={`url(#${id}-fade)`} />
			</mask>
			<g mask={`url(#${id}-floor)`} stroke="var(--line-art-faint)" strokeWidth={0.6} opacity={0.55}>
				{lines}
			</g>
		</g>
	);
}

function Frame({ children, label, viewBox, className }: { children: ReactNode; label: string; viewBox: string; className?: string }) {
	const id = `art${useId().replace(/[^\w-]/g, '')}`;
	const grad = (name: string, from: string, to: string, diagonal?: boolean) => (
		<linearGradient id={`${id}-${name}`} x1="0" y1="0" x2={diagonal ? 1 : 0} y2="1">
			<stop offset="0" stopColor={from} />
			<stop offset="1" stopColor={to} />
		</linearGradient>
	);
	return (
		<svg role="img" aria-label={label} viewBox={viewBox} className={className} fill="none" style={{ maxWidth: '100%', height: 'auto' }}>
			<defs>
				{grad('dark-top', 'var(--art-top)', 'var(--art-left)', true)}
				{grad('dark-left', 'var(--art-left)', 'var(--art-right)')}
				{grad('dark-right', 'var(--art-right)', 'var(--well-bg)')}
				{grad('acc-top', 'var(--cyan-300)', 'var(--cyan-500)', true)}
				{grad('acc-left', 'var(--cyan-600)', 'var(--cyan-800)')}
				{grad('acc-right', 'var(--cyan-800)', 'var(--cyan-900)')}
				<linearGradient id={`${id}-cyl`} x1="0" y1="0" x2="1" y2="0">
					<stop offset="0" stopColor="var(--art-right)" />
					<stop offset="0.3" stopColor="var(--art-top)" />
					<stop offset="0.7" stopColor="var(--art-left)" />
					<stop offset="1" stopColor="var(--well-bg)" />
				</linearGradient>
				<linearGradient id={`${id}-cylA`} x1="0" y1="0" x2="1" y2="0">
					<stop offset="0" stopColor="var(--cyan-800)" />
					<stop offset="0.3" stopColor="var(--cyan-600)" />
					<stop offset="0.7" stopColor="var(--cyan-700)" />
					<stop offset="1" stopColor="var(--cyan-900)" />
				</linearGradient>
				<radialGradient id={`${id}-glow`}>
					<stop offset="0" stopColor="var(--accent-base)" stopOpacity="0.5" />
					<stop offset="1" stopColor="var(--accent-base)" stopOpacity="0" />
				</radialGradient>
				<radialGradient id={`${id}-fade`}>
					<stop offset="0" stopColor="#fff" />
					<stop offset="1" stopColor="#000" />
				</radialGradient>
			</defs>
			<ArtId.Provider value={id}>{children}</ArtId.Provider>
		</svg>
	);
}

/** Corner posts, drawn back to front. */
function Posts({ at, spread, z, h }: { at: Pair; spread: Pair; z: number; h: number }) {
	const corners: Pair[] = [
		[at[0], at[1]],
		[at[0] + spread[0], at[1]],
		[at[0], at[1] + spread[1]],
		[at[0] + spread[0], at[1] + spread[1]],
	];
	return (
		<>
			{corners.map(([x, y]) => (
				<Box key={`${x}-${y}`} at={[x, y, z]} size={[4, 4, h]} />
			))}
		</>
	);
}

/* ——— Drawings ——— */

/** A machine in layers, its lit core on top and a beam rising from it: a sandbox waiting for work. */
export function SandboxArt({ className }: { className?: string }) {
	return (
		<Frame label="A stack of sandbox layers around a lit core" viewBox="-90 -74 205 170" className={className}>
			<Floor at={[42, 42]} />
			<Box
				at={[0, 0, 0]}
				size={[84, 84, 8]}
				bezel={4}
				top={
					<>
						<Trace points={[[0, 14], [18, 14], [18, 26], [30, 26]]} dim />
						<Trace points={[[0, 42], [26, 42]]} dim />
						<Trace points={[[0, 70], [18, 70], [18, 58], [30, 58]]} dim />
						<Trace points={[[84, 20], [66, 20], [66, 30]]} dim />
						<Trace points={[[84, 64], [66, 64], [66, 54]]} dim />
						<Ring at={[18, 26]} r={1.4} dim />
						<Ring at={[66, 30]} r={1.4} dim />
					</>
				}
				left={
					<>
						{[10, 15, 20, 25].map((u) => (
							<Ln key={u} a={[u, 2]} b={[u, 6]} dim />
						))}
						<Led at={[72, 4]} lit />
						<Led at={[77, 4]} />
					</>
				}
				right={
					<>
						{[10, 15, 20, 25].map((u) => (
							<Ln key={u} a={[u, 2]} b={[u, 6]} dim />
						))}
						<Led at={[72, 4]} />
					</>
				}
			/>
			<Posts at={[13, 13]} spread={[54, 54]} z={8} h={14} />
			<Box
				at={[10, 10, 22]}
				size={[64, 64, 8]}
				bezel={3}
				top={
					<>
						<Rc x={20} y={20} w={24} h={24} dim />
						<Rc x={25} y={25} w={14} h={14} dim />
						{[24, 32, 40].map((v) => (
							<g key={v}>
								<Ln a={[v, 20]} b={[v, 10]} dim />
								<Ln a={[v, 44]} b={[v, 54]} dim />
								<Ln a={[20, v]} b={[10, v]} dim />
								<Ln a={[44, v]} b={[54, v]} dim />
							</g>
						))}
					</>
				}
				left={
					<>
						<Vents x={8} y={2} w={22} n={3} gap={2} />
						<Led at={[54, 4]} lit />
					</>
				}
				right={<Vents x={8} y={2} w={22} n={3} gap={2} />}
			/>
			<Posts at={[25, 25]} spread={[30, 30]} z={30} h={14} />
			<Box
				at={[22, 22, 44]}
				size={[40, 40, 8]}
				bezel={3}
				top={
					<>
						<Ring at={[20, 20]} r={11} dim />
						<Ring at={[20, 20]} r={15} dim dash="2 3" />
					</>
				}
				left={<Led at={[34, 4]} lit />}
			/>
			<Glow at={[42, 42, 52]} r={30} />
			<Box
				at={[32, 32, 52]}
				size={[20, 20, 20]}
				accent
				bezel={3.5}
				top={
					<>
						<Ring at={[10, 10]} r={3.4} accent />
						<Ring at={[10, 10]} r={1} fill="var(--cyan-100)" accent />
					</>
				}
				left={
					<>
						<Rc x={4} y={10} w={12} h={3} r={1.5} fill="var(--cyan-900)" accent />
						<Ln a={[4, 6]} b={[11, 6]} accent />
					</>
				}
				right={
					<>
						{[5, 10, 15].map((u) => (
							<Ln key={u} a={[u, 5]} b={[u, 15]} accent />
						))}
					</>
				}
			/>
			<Path from={[42, 42, 72]} to={[42, 42, 104]} accent />
			<Path from={[42, 42, 72]} to={[42, 42, 100]} accent solid width={0.5} />
			<Tag at={[84, 14, 4]}>idle</Tag>
		</Frame>
	);
}

/** A rack on a base plate sending a branch along a dotted route to its own plate: a pull request. */
export function BranchArt({ className }: { className?: string }) {
	return (
		<Frame label="A branch route from a base plate to a second plate" viewBox="-112 -18 308 110" className={className}>
			<Floor at={[56, 40]} cells={8} />
			<Box at={[0, 40, 0]} size={[64, 60, 8]} bezel={3} top={<Trace points={[[10, 4], [10, 12], [24, 12]]} dim />} />
			<Box
				at={[8, 48, 8]}
				size={[28, 28, 24]}
				left={
					<>
						<Vents x={5} y={5} w={18} n={4} gap={3} />
						<Rc x={5} y={16} w={18} h={4} r={1} dim />
						<Led at={[20, 18]} lit />
					</>
				}
				right={
					<>
						<Vents x={5} y={5} w={18} n={4} gap={3} />
						<Led at={[7, 18]} />
					</>
				}
				bezel={3}
			/>
			<Box at={[42, 58, 8]} size={[16, 16, 10]} left={<Vents x={3} y={3} w={10} n={2} gap={3} />} right={<Led at={[8, 5]} />} />
			<Box at={[64, 66, 0]} size={[28, 4, 1]} ghost dashed />
			<Box at={[88, 30, 0]} size={[4, 40, 1]} ghost dashed />
			<Path from={[64, 68, 1]} to={[90, 68, 1]} accent />
			<Path from={[90, 68, 1]} to={[90, 36, 1]} accent />
			<Cylinder at={[76, 68, 1]} r={3.2} h={3} />
			<Cylinder at={[90, 52, 1]} r={3.2} h={3} accent />
			<Box at={[74, -10, 0]} size={[56, 44, 8]} bezel={3} top={<Trace points={[[46, 34], [46, 24], [34, 24]]} dim />} />
			<Glow at={[102, 12, 8]} r={26} />
			<Box
				at={[88, -2, 8]}
				size={[24, 24, 20]}
				accent
				bezel={3}
				top={<Ring at={[12, 12]} r={3.4} accent />}
				left={<Trace points={[[6, 10], [10.5, 5.5], [18, 14]]} accent />}
				right={<Vents x={5} y={5} w={14} n={4} gap={3} />}
			/>
			<Tag at={[-6, 112, 6]}>main</Tag>
			<Tag at={[132, -12, 6]}>anton/…</Tag>
		</Frame>
	);
}

/** Disks stacked in a column on a base, the top one lit: what storage keeps. */
export function StorageArt({ className }: { className?: string }) {
	const disk = (z: number, accent?: boolean) => (
		<Cylinder at={[44, 44, z]} r={28} h={10} accent={accent}>
			<Ring at={[0, 0]} r={20} accent={accent} dim={!accent} />
			<Ring at={[0, 0]} r={11} accent={accent} dim={!accent} />
			<Ring at={[0, 0]} r={3} fill={accent ? 'var(--cyan-100)' : 'var(--art-right)'} accent={accent} />
			<Ln a={[3, 0]} b={[20, 0]} accent={accent} dim={!accent} />
		</Cylinder>
	);
	const led = (z: number, lit?: boolean) => {
		const [cx, cy] = pt([44, 44, z]);
		const front = cy + 28 * ELLIPSE_Y;
		return (
			<g key={z}>
				{[-9, -4].map((o) => (
					<circle key={o} cx={cx + o + 14} cy={front - 4.6} r={1.1} fill="var(--line-art-faint)" />
				))}
				<circle cx={cx + 14 + 3} cy={front - 4.6} r={1.2} fill={lit ? 'var(--cyan-100)' : 'var(--line-art)'} />
			</g>
		);
	};
	return (
		<Frame label="Stacked storage disks" viewBox="-90 -56 180 156" className={className}>
			<Floor at={[44, 44]} cells={6} />
			<Box at={[0, 0, 0]} size={[88, 88, 6]} bezel={3} left={<Led at={[80, 3]} lit />} right={<Vents x={10} y={1.5} w={20} n={2} gap={2} />} />
			{disk(6)}
			{led(6)}
			{disk(20)}
			{led(20)}
			{disk(34)}
			{led(34)}
			<Glow at={[44, 44, 54]} r={34} />
			{disk(48, true)}
			{led(48, true)}
		</Frame>
	);
}

/** A tray of cards standing in slots, one lifted out and lit: a task list waiting for its first task. */
export function TasksArt({ className }: { className?: string }) {
	const card = (y: number, h: number, accent?: boolean, z = 10) => (
		<Box
			key={y}
			at={[10, y, z]}
			size={[80, 3, h]}
			accent={accent}
			left={
				<>
					<Rc x={5} y={h - 9} w={6} h={6} r={1.5} accent={accent} dim={!accent} />
					{accent ? <Trace points={[[6.4, h - 6], [7.9, h - 7.6], [10, h - 4.2]]} accent /> : null}
					<Bars x={16} y={h - 5.4} widths={accent ? [44, 28] : [44, 28]} gap={4} accent={accent} />
				</>
			}
		/>
	);
	return (
		<Frame label="A tray of task cards, one lifted" viewBox="-80 -52 245 150" className={className}>
			<Floor at={[50, 36]} cells={8} />
			<Box
				at={[0, 0, 0]}
				size={[100, 72, 10]}
				top={
					<>
						<Rc x={5} y={5} w={90} h={62} r={2} fill="var(--well-bg)" dim />
						{[27, 43].map((v) => (
							<Ln key={v} a={[10, v]} b={[90, v]} dim dash="2 3" />
						))}
					</>
				}
				left={<Vents x={70} y={3} w={20} n={2} gap={3} />}
				right={<Led at={[10, 5]} lit />}
			/>
			{card(12, 40)}
			{card(28, 33)}
			{card(44, 26)}
			<Path from={[10, 58, 24]} to={[10, 58, 10]} accent />
			<Path from={[90, 58, 24]} to={[90, 58, 10]} accent />
			<Glow at={[50, 58, 10]} r={34} />
			{card(58, 26, true, 24)}
			<Tag at={[100, -4, 10]}>queue</Tag>
		</Frame>
	);
}

/** Two devices joined by a lit cable: a connection to an outside service. */
export function LinkArt({ className }: { className?: string }) {
	const cable: Point[] = [
		[44, 52, 12],
		[102, 52, 12],
		[102, 14, 12],
	];
	return (
		<Frame label="Two devices joined by a cable" viewBox="-80 -24 230 114" className={className}>
			<Floor at={[64, 26]} cells={8} />
			<Box
				at={[0, 32, 0]}
				size={[44, 44, 26]}
				bezel={3}
				top={
					<>
						<Ring at={[12, 12]} r={5} dim />
						<Ring at={[12, 12]} r={1.4} dim />
						<Ln a={[24, 8]} b={[38, 8]} dim />
						<Ln a={[24, 14]} b={[38, 14]} dim />
					</>
				}
				left={
					<>
						<Vents x={6} y={6} w={20} n={4} gap={3} />
						<Led at={[34, 20]} lit />
						<Led at={[38, 20]} />
					</>
				}
				right={
					<>
						<Rc x={14} y={8} w={16} h={8} r={1.5} fill="var(--well-bg)" />
						<Ln a={[18, 12]} b={[26, 12]} dim />
					</>
				}
			/>
			<Path from={[44, 52, 0]} to={[102, 52, 0]} />
			<Path from={[102, 52, 0]} to={[102, 14, 0]} />
			<Path from={cable[1]} to={[102, 52, 0]} width={0.5} />
			<Path from={cable[0]} to={cable[1]} accent solid width={2.4} />
			<Path from={cable[1]} to={cable[2]} accent solid width={2.4} />
			<Box at={[44, 49.5, 9.5]} size={[6, 5, 5]} right={<Ln a={[1, 2.5]} b={[4, 2.5]} dim />} />
			<Box
				at={[80, -32, 0]}
				size={[44, 46, 26]}
				accent
				bezel={3}
				top={
					<>
						<Ring at={[12, 12]} r={5} accent />
						<Ring at={[12, 12]} r={1.4} fill="var(--cyan-100)" accent />
						<Ln a={[24, 8]} b={[38, 8]} accent />
						<Ln a={[24, 14]} b={[38, 14]} accent />
					</>
				}
				left={
					<>
						<Rc x={14} y={8} w={16} h={8} r={1.5} fill="var(--cyan-900)" accent />
						<Ln a={[18, 12]} b={[26, 12]} accent />
						<Led at={[6, 20]} lit />
					</>
				}
				right={<Vents x={8} y={6} w={24} n={4} gap={3} />}
			/>
			<Box at={[99.5, 14, 9.5]} size={[5, 6, 5]} left={<Ln a={[1, 2.5]} b={[4, 2.5]} dim />} />
			<Glow at={[102, 14, 0]} r={16} />
		</Frame>
	);
}

/** Checkpoints along a rail, each one taller than the last, the newest lit with a clock: saved states. */
export function HistoryArt({ className }: { className?: string }) {
	const dial = (accent?: boolean) => (
		<>
			<Ring at={[16, 16]} r={10} accent={accent} dim={!accent} />
			<Ring at={[16, 16]} r={6} dim dash="1.5 2" accent={accent} />
			{accent ? (
				<>
					<Trace points={[[16, 16], [16, 23]]} accent />
					<Trace points={[[16, 16], [21, 12.5]]} accent />
				</>
			) : null}
			<Ring at={[16, 16]} r={1.3} fill={accent ? 'var(--cyan-100)' : 'var(--line-art-faint)'} accent={accent} />
		</>
	);
	return (
		<Frame label="Checkpoints along a timeline" viewBox="-56 -14 235 122" className={className}>
			<Floor at={[56, 30]} cells={8} />
			<Box at={[-14, 30, 0]} size={[162, 4, 1]} ghost dashed />
			<Box at={[0, 14, 0]} size={[32, 32, 6]} dashed ghost top={dial()} />
			<Box
				at={[46, 14, 0]}
				size={[32, 32, 14]}
				bezel={3}
				top={dial()}
				left={<Vents x={6} y={3} w={16} n={2} gap={3} />}
				right={<Led at={[6, 6]} />}
			/>
			<Glow at={[108, 30, 0]} r={34} />
			<Box
				at={[92, 14, 0]}
				size={[32, 32, 24]}
				accent
				bezel={3}
				top={dial(true)}
				left={
					<>
						<Vents x={6} y={4} w={16} n={4} gap={3} />
						<Led at={[22, 17]} lit />
					</>
				}
				right={<Led at={[6, 18]} lit />}
			/>
			<Tag at={[128, 0, 28]}>now</Tag>
		</Frame>
	);
}

/** Sheets stacked in an open tray, the top one lit with a picture and text: reports and screenshots the agent kept. */
export function LibraryArt({ className }: { className?: string }) {
	const sheet = (offset: number, z: number, accent?: boolean) => (
		<Box
			key={z}
			at={[8 + offset, 8 + offset * 0.8, z]}
			size={[52, 40, 2]}
			accent={accent}
			top={
				accent ? (
					<>
						<Rc x={5} y={21} w={20} h={14} r={1.5} fill="var(--cyan-900)" accent />
						<Trace points={[[7, 24], [12, 29], [16, 26], [23, 32]]} accent />
						<Ring at={[21, 32]} r={1.3} accent />
						<Bars x={29} y={33} widths={[16, 16, 10]} gap={4} accent />
						<Bars x={5} y={14} widths={[42, 42, 28]} gap={4} accent />
					</>
				) : (
					<>
						<Bars x={5} y={34} widths={[40, 40, 24]} gap={4} />
					</>
				)
			}
		/>
	);
	return (
		<Frame label="Saved sheets in an open tray" viewBox="-72 -36 222 126" className={className}>
			<Floor at={[42, 34]} cells={7} />
			<Box at={[0, 0, 0]} size={[84, 68, 8]} bezel={3} left={<Led at={[76, 4]} lit />} right={<Vents x={10} y={1.5} w={20} n={2} gap={2} />} />
			<Box at={[0, 0, 8]} size={[84, 3, 14]} left={<Ln a={[0, 7]} b={[84, 7]} dim />} />
			<Box at={[0, 3, 8]} size={[3, 65, 14]} right={<Ln a={[0, 7]} b={[65, 7]} dim />} />
			{sheet(0, 8)}
			{sheet(5, 11)}
			<Glow at={[28, 22, 14]} r={34} />
			{sheet(10, 14, true)}
			<Tag at={[84, -6, 4]}>saved</Tag>
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
