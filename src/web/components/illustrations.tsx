import { type ReactNode, useId } from 'react';

/* Line-art isometric drawings for empty and quiet states. Each is drawn from
   boxes in a 3D grid, projected at 30°, so they share one perspective. */

type Point = [number, number, number];

const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;

const project = ([x, y, z]: Point): string => `${((x - y) * COS).toFixed(2)},${((x + y) * SIN - z).toFixed(2)}`;
const poly = (points: Point[]) => points.map(project).join(' ');

type Face = 'top' | 'left' | 'right';

/** A box's three visible faces, from its near corner at (x, y, z). */
function boxFaces(x: number, y: number, z: number, w: number, d: number, h: number): Record<Face, string> {
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

function Box({ at, size, accent, dashed }: { at: Point; size: Point; accent?: boolean; dashed?: boolean }) {
	const faces = boxFaces(...at, ...size);
	const stroke = accent ? 'var(--accent-base)' : 'var(--line-art)';
	const dash = dashed ? '3 3' : undefined;
	return (
		<g strokeLinejoin="round" strokeWidth={1}>
			<polygon points={faces.left} fill={accent ? 'var(--cyan-800)' : 'var(--well-bg)'} stroke={stroke} strokeDasharray={dash} />
			<polygon points={faces.right} fill={accent ? 'var(--cyan-900)' : 'var(--well-bg)'} stroke={stroke} strokeDasharray={dash} />
			<polygon points={faces.top} fill={accent ? 'var(--cyan-600)' : 'var(--card-bg-top)'} stroke={stroke} strokeDasharray={dash} />
		</g>
	);
}

/** A line between two grid points, dashed by default. */
function Path({ from, to, accent, solid }: { from: Point; to: Point; accent?: boolean; solid?: boolean }) {
	const [x1, y1] = project(from).split(',');
	const [x2, y2] = project(to).split(',');
	return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={accent ? 'var(--accent-base)' : 'var(--line-art-faint)'} strokeDasharray={solid ? undefined : '3 4'} />;
}

/** A small mono tag stuck on the drawing, like the labels on a technical diagram. */
function Tag({ at, children }: { at: Point; children: ReactNode }) {
	const [x, y] = project(at).split(',').map(Number);
	return (
		<g transform={`translate(${x} ${y})`}>
			<rect x={-2} y={-9} width={String(children).length * 6.2 + 10} height={14} rx={3} fill="var(--bg-overlay)" stroke="var(--line-art-faint)" />
			<text x={3} y={1} fill="var(--text-tertiary)" style={{ font: '500 8.5px var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
				{children}
			</text>
		</g>
	);
}

function Frame({ children, label, viewBox, className }: { children: ReactNode; label: string; viewBox: string; className?: string }) {
	return (
		<svg role="img" aria-label={label} viewBox={viewBox} className={className} fill="none" style={{ maxWidth: '100%', height: 'auto' }}>
			{children}
		</svg>
	);
}

/** Three machine plates stacked, the top one lit: a sandbox waiting for work. */
export function SandboxArt({ className }: { className?: string }) {
	return (
		<Frame label="A stack of sandbox layers" viewBox="-110 -70 220 150" className={className}>
			<Box at={[0, 0, 0]} size={[70, 70, 8]} />
			<Box at={[6, 6, 16]} size={[58, 58, 8]} dashed />
			<Box at={[12, 12, 32]} size={[46, 46, 8]} />
			<Box at={[26, 26, 44]} size={[18, 18, 16]} accent />
			<Path from={[35, 35, 60]} to={[35, 35, 92]} accent />
			<Tag at={[70, -6, 4]}>idle</Tag>
		</Frame>
	);
}

/** A branch leaving a base plate along a dashed route to its own plate: a pull request. */
export function BranchArt({ className }: { className?: string }) {
	return (
		<Frame label="A branch reaching a second plate" viewBox="-130 -40 260 140" className={className}>
			<Box at={[0, 40, 0]} size={[56, 56, 8]} />
			<Box at={[14, 54, 8]} size={[14, 14, 14]} />
			<Box at={[30, 58, 8]} size={[10, 10, 8]} />
			<Path from={[56, 68, 8]} to={[96, 68, 8]} />
			<Path from={[96, 68, 8]} to={[96, 20, 8]} />
			<Box at={[84, -16, 0]} size={[48, 40, 8]} />
			<Box at={[100, -6, 8]} size={[16, 16, 10]} accent />
			<Tag at={[-6, 108, 6]}>main</Tag>
			<Tag at={[134, -18, 6]}>anton/…</Tag>
		</Frame>
	);
}

/** Disks stacked in a column, the top one lit: what storage keeps. */
export function StorageArt({ className }: { className?: string }) {
	const disk = (z: number, accent?: boolean, dashed?: boolean) => {
		const rx = 46;
		const ry = 22;
		const h = 12;
		const stroke = accent ? 'var(--accent-base)' : 'var(--line-art)';
		return (
			<g key={z} transform={`translate(0 ${-z})`} strokeDasharray={dashed ? '3 3' : undefined}>
				<path d={`M ${-rx} 0 V ${h} A ${rx} ${ry} 0 0 0 ${rx} ${h} V 0`} fill={accent ? 'var(--cyan-900)' : 'var(--well-bg)'} stroke={stroke} />
				<ellipse cx={0} cy={0} rx={rx} ry={ry} fill={accent ? 'var(--cyan-700)' : 'var(--card-bg-top)'} stroke={stroke} />
			</g>
		);
	};
	return (
		<Frame label="Stacked storage disks" viewBox="-80 -80 160 130" className={className}>
			<ellipse cx={0} cy={26} rx={58} ry={26} stroke="var(--line-art-faint)" strokeDasharray="3 4" />
			{disk(-8)}
			{disk(12, false, true)}
			{disk(32)}
			{disk(52, true)}
		</Frame>
	);
}

/** A tray of cards, one lifted and lit: a task list waiting for its first task. */
export function TasksArt({ className }: { className?: string }) {
	return (
		<Frame label="A tray of task cards" viewBox="-120 -60 240 140" className={className}>
			<Box at={[0, 0, 0]} size={[100, 64, 10]} />
			<Box at={[10, 8, 10]} size={[80, 10, 26]} />
			<Box at={[10, 24, 10]} size={[80, 10, 26]} dashed />
			<Box at={[10, 40, 10]} size={[80, 10, 26]} />
			<Box at={[24, 30, 52]} size={[60, 6, 30]} accent />
			<Tag at={[100, -8, 8]}>queue</Tag>
		</Frame>
	);
}

/** Two plates joined by a lit line: a connection to an outside service. */
export function LinkArt({ className }: { className?: string }) {
	return (
		<Frame label="Two plates joined by a line" viewBox="-120 -40 240 120" className={className}>
			<Box at={[0, 30, 0]} size={[44, 44, 8]} />
			<Box at={[12, 42, 8]} size={[20, 20, 12]} />
			<Path from={[44, 52, 14]} to={[92, 4, 14]} accent solid />
			<Box at={[80, -30, 0]} size={[44, 44, 8]} />
			<Box at={[92, -18, 8]} size={[20, 20, 12]} accent />
		</Frame>
	);
}

/** Plates stepping back in time along a dashed rail, the newest lit: saved checkpoints. */
export function HistoryArt({ className }: { className?: string }) {
	return (
		<Frame label="Checkpoints along a timeline" viewBox="-120 -50 240 130" className={className}>
			<Path from={[-20, 30, 0]} to={[120, 30, 0]} />
			<Box at={[0, 14, 0]} size={[28, 28, 6]} dashed />
			<Box at={[40, 14, 0]} size={[28, 28, 12]} />
			<Box at={[80, 14, 0]} size={[28, 28, 22]} accent />
			<Tag at={[110, 0, 26]}>now</Tag>
		</Frame>
	);
}

/** Sheets fanned on a plate, the top one lit: reports and screenshots the agent kept. */
export function LibraryArt({ className }: { className?: string }) {
	return (
		<Frame label="Saved sheets on a plate" viewBox="-110 -60 220 130" className={className}>
			<Box at={[0, 0, 0]} size={[80, 64, 6]} />
			<Box at={[10, 10, 6]} size={[52, 40, 2]} dashed />
			<Box at={[16, 14, 12]} size={[52, 40, 2]} />
			<Box at={[22, 18, 18]} size={[52, 40, 2]} accent />
			<Tag at={[80, -6, 4]}>saved</Tag>
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
