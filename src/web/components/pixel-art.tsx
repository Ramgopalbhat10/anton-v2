import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/*
 * Pixel drawings: Anton's illustrations are drawn on the same grid as the sky's
 * mesh behind the app. Each is a few dozen cells across, built with `Grid`
 * (lines, boxes, circles) and drawn by `PixelArt` as SVG squares, five CSS
 * pixels a cell, like the sky's mesh. One accent, a few greys, and motion
 * only where something is alive: a twinkle, or a pulse running along a line.
 *
 * Cell codes:
 *   #  edge         =  mid          -  faint
 *   @  accent       o  accent, dim  *  accent, twinkling
 *   ~  a run: lights in turn, left to right, like data along a wire
 *   g  success      r  danger       y  warning
 *   _  a blinking cursor
 */

export type Cell = '#' | '=' | '-' | '@' | 'o' | '*' | '~' | 'g' | 'r' | 'y' | '_' | '.';

export class Grid {
	readonly cells: Cell[][];
	constructor(
		readonly width: number,
		readonly height: number,
	) {
		this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => '.' as Cell));
	}
	set(x: number, y: number, cell: Cell) {
		if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.cells[y][x] = cell;
		return this;
	}
	/** A filled rectangle; '.' clears it, so a shape in front hides what is behind. */
	fill(x: number, y: number, w: number, h: number, cell: Cell) {
		for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) this.set(col, row, cell);
		return this;
	}
	/** A rectangle's outline, its inside cleared, with the corners cut for a softer box. */
	box(x: number, y: number, w: number, h: number, cell: Cell, { round = true, inside = '.' as Cell | null } = {}) {
		if (inside) this.fill(x + 1, y + 1, w - 2, h - 2, inside);
		for (let col = x + (round ? 1 : 0); col < x + w - (round ? 1 : 0); col++) {
			this.set(col, y, cell);
			this.set(col, y + h - 1, cell);
		}
		for (let row = y + (round ? 1 : 0); row < y + h - (round ? 1 : 0); row++) {
			this.set(x, row, cell);
			this.set(x + w - 1, row, cell);
		}
		return this;
	}
	hline(x: number, y: number, length: number, cell: Cell, every = 1) {
		for (let index = 0; index < length; index += every) this.set(x + index, y, cell);
		return this;
	}
	vline(x: number, y: number, length: number, cell: Cell, every = 1) {
		for (let index = 0; index < length; index += every) this.set(x, y + index, cell);
		return this;
	}
	/** A straight line between two cells (Bresenham), every `every`th cell drawn. */
	line(x0: number, y0: number, x1: number, y1: number, cell: Cell, every = 1) {
		const dx = Math.abs(x1 - x0);
		const dy = -Math.abs(y1 - y0);
		const sx = x0 < x1 ? 1 : -1;
		const sy = y0 < y1 ? 1 : -1;
		let error = dx + dy;
		let x = x0;
		let y = y0;
		for (let step = 0; ; step++) {
			if (step % every === 0) this.set(x, y, cell);
			if (x === x1 && y === y1) break;
			const twice = 2 * error;
			if (twice >= dy) {
				error += dy;
				x += sx;
			}
			if (twice <= dx) {
				error += dx;
				y += sy;
			}
		}
		return this;
	}
	/** A circle's outline (midpoint), every `every`th cell drawn. */
	circle(cx: number, cy: number, r: number, cell: Cell, every = 1) {
		const points: Array<[number, number]> = [];
		let x = r;
		let y = 0;
		let error = 1 - r;
		while (x >= y) {
			points.push([x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]);
			y++;
			if (error < 0) error += 2 * y + 1;
			else {
				x--;
				error += 2 * (y - x) + 1;
			}
		}
		const seen = new Set<string>();
		points
			.map(([px, py]) => [cx + px, cy + py] as const)
			.filter(([px, py]) => {
				const key = `${px},${py}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))
			.forEach(([px, py], index) => index % every === 0 && this.set(px, py, cell));
		return this;
	}
	/** A filled disc. */
	disc(cx: number, cy: number, r: number, cell: Cell) {
		for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) this.set(cx + x, cy + y, cell);
		return this;
	}
	/** Rows of a sprite, '.' or ' ' leaving what is under it. */
	stamp(x: number, y: number, rows: string[]) {
		rows.forEach((row, dy) => [...row].forEach((cell, dx) => cell !== ' ' && cell !== '.' && this.set(x + dx, y + dy, cell as Cell)));
		return this;
	}
}

const FILL: Record<Exclude<Cell, '.'>, string> = {
	'#': 'var(--px-edge)',
	'=': 'var(--px-mid)',
	'-': 'var(--px-faint)',
	'@': 'var(--accent-base)',
	o: 'var(--px-accent-dim)',
	'*': 'var(--accent-hover)',
	'~': 'var(--accent-base)',
	g: 'var(--success-base)',
	r: 'var(--danger-base)',
	y: 'var(--warning-base)',
	_: 'var(--px-edge)',
};

const CLASS: Partial<Record<Cell, string>> = { '*': 'px-twinkle', '~': 'px-run', _: 'art-blink' };

/** Text set in the drawing, in Anton's mono, measured in cells. */
export type PixelLabel = { x: number; y: number; text: string; accent?: boolean; anchor?: 'start' | 'middle' | 'end'; size?: number };

/**
 * A pixel drawing. `stages` lights groups of cells in turn (cells in a column range
 * per stage), for drawings that show steps one after another.
 */
export function PixelArt({
	grid,
	label,
	className,
	labels = [],
	stages,
	cell = 5,
}: {
	grid: Grid;
	label: string;
	className?: string;
	labels?: PixelLabel[];
	stages?: Array<[number, number]>;
	/** CSS pixels per cell: the sky's mesh is 5, so a drawing sits on the same grid. */
	cell?: number;
}) {
	const { width, height, cells } = grid;
	const stageOf = (x: number) => (stages ? stages.findIndex(([from, to]) => x >= from && x <= to) : -1);
	let twinkle = 0;
	return (
		<svg
			role="img"
			aria-label={label}
			viewBox={`-1 -1 ${width + 2} ${height + 2}`}
			className={cn('px-art', className)}
			// Drawn at whole pixels per cell, whatever width the caller asks for, so every cell stays sharp.
			style={{ width: (width + 2) * cell, height: 'auto', maxWidth: '100%' }}
			shapeRendering="crispEdges"
		>
			{cells.flatMap((row, y) =>
				row.map((cell, x) => {
					if (cell === '.') return null;
					const stage = cell === '@' || cell === 'o' ? stageOf(x) : -1;
					const style: CSSProperties | undefined =
						cell === '*' ? ({ '--i': twinkle++ } as CSSProperties) : cell === '~' ? ({ '--i': x } as CSSProperties) : stage >= 0 ? ({ '--stage': stage } as CSSProperties) : undefined;
					return (
						<rect
							key={`${x},${y}`}
							x={x + 0.08}
							y={y + 0.08}
							width={0.84}
							height={0.84}
							fill={FILL[cell]}
							className={stage >= 0 ? 'px-stage' : CLASS[cell]}
							style={style}
						/>
					);
				}),
			)}
			{labels.map((item) => (
				<text
					key={`${item.x},${item.y},${item.text}`}
					x={item.x}
					y={item.y}
					textAnchor={item.anchor ?? 'start'}
					dominantBaseline="middle"
					fill={item.accent ? 'var(--accent-text)' : 'var(--text-tertiary)'}
					style={{ font: `500 ${item.size ?? 2.1}px var(--font-mono)`, letterSpacing: '0.04em' }}
				>
					{item.text}
				</text>
			))}
		</svg>
	);
}
