import { Grid, PixelArt, type PixelLabel } from '@/components/pixel-art';
import { cn } from '@/lib/utils';

/*
 * Anton's illustrations, drawn on the sky's pixel grid (see pixel-art.tsx):
 * small, flat, a few greys and one accent, so they sit in an empty state
 * without shouting. Each drawing is built once, when the module loads.
 */

/* ——— Small sprites, 5×5, lit in the accent ——— */

const SPRITE = {
	read: ['@@@@.', '@..@@', '@@@.@', '@...@', '@@@@@'],
	branch: ['@...@', '@...@', '@..@.', '@@@..', '@....'],
	terminal: ['@....', '.@...', '..@..', '.@...', '@.@@@'],
	pull: ['@.@@.', '@...@', '@...@', '@...@', '@...@'],
	ask: ['@@@@@', '@...@', '@@@@@', '.@...', '.....'],
	globe: ['.@@@.', '@.@.@', '@@@@@', '@.@.@', '.@@@.'],
	answer: ['@@@@@', '.....', '@@@@.', '.....', '@@@..'],
	plan: ['@.@@@', '.....', '@.@@@', '.....', '@.@@.'],
	threads: ['@@@..', '.....', '.@@@@', '.....', '@@@@.'],
	review: ['.....', '.@@@.', '@.@.@', '.@@@.', '.....'],
	done: ['.....', '....@', '...@.', '@.@..', '.@...'],
} as const;

type Sprite = keyof typeof SPRITE;

const dim = (rows: readonly string[]) => rows.map((row) => row.replaceAll('@', '='));

/* ——— Empty and quiet states ——— */

/** Three cards, stacked: the tasks to come. */
const TASKS = (() => {
	const g = new Grid(44, 21);
	g.box(17, 1, 18, 12, '-');
	g.box(13, 4, 18, 12, '=');
	g.box(9, 7, 18, 13, '#');
	g.fill(12, 10, 2, 2, '@');
	g.hline(16, 10, 8, '=').hline(16, 11, 5, '-');
	g.hline(12, 14, 12, '-').hline(12, 16, 9, '-');
	g.set(33, 2, '*');
	return g;
})();

export function TasksArt({ className }: { className?: string }) {
	return <PixelArt grid={TASKS} label="A stack of task cards, the top one ready" className={className} />;
}

/** A coordinator wired to three threads, one of them at work: a project. */
const PROJECT = (() => {
	const g = new Grid(52, 27);
	g.line(25, 7, 9, 18, '-', 2);
	g.line(27, 7, 43, 18, '-', 2);
	g.vline(26, 8, 10, '~');
	g.box(22, 2, 9, 7, '@');
	g.fill(25, 4, 3, 3, 'o');
	g.set(26, 5, '*');
	g.box(5, 17, 8, 6, '#');
	g.hline(7, 19, 4, '-');
	g.box(22, 18, 9, 6, '@');
	g.hline(24, 20, 5, 'o').hline(24, 21, 3, 'o');
	g.box(40, 17, 8, 6, '#');
	g.hline(42, 19, 4, '-');
	return g;
})();

export function ProjectArt({ className }: { className?: string }) {
	return (
		<PixelArt
			grid={PROJECT}
			label="A coordinator wired to three threads running side by side"
			className={className}
			labels={[
				{ x: 33, y: 5.5, text: 'coordinator' },
				{ x: 26.5, y: 25.8, text: 'working', accent: true, anchor: 'middle' },
			]}
		/>
	);
}

/** A terminal window, its cursor blinking, with a status beside it. */
const SANDBOX = (() => {
	const g = new Grid(56, 21);
	g.box(3, 1, 34, 19, '#');
	g.hline(4, 4, 32, '-');
	g.set(5, 2, '=').set(7, 2, '=').set(9, 2, '=');
	g.stamp(6, 7, ['@..', '.@.', '@..']);
	g.hline(10, 8, 12, '=');
	g.hline(6, 11, 18, '-');
	g.hline(6, 13, 14, '-');
	g.stamp(6, 15, ['@..', '.@.', '@..']);
	g.set(10, 16, '_').set(11, 16, '_');
	g.hline(38, 10, 6, '-', 2);
	g.set(37, 10, '@');
	return g;
})();

export function SandboxArt({ className, label = 'idle' }: { className?: string; label?: string }) {
	return <PixelArt grid={SANDBOX} label={`A compute unit with a terminal, ${label}`} className={className} labels={[{ x: 45, y: 10.5, text: label, accent: true }]} />;
}

/** A branch leaving main, its newest commit lit, on its way back as a pull request. */
const BRANCH = (() => {
	const g = new Grid(52, 18);
	g.hline(2, 13, 48, '=');
	g.disc(9, 13, 1, '#');
	g.disc(19, 13, 1, '#');
	g.line(20, 12, 25, 7, '=');
	g.hline(26, 6, 12, '~');
	g.disc(29, 6, 1, '#');
	g.disc(39, 6, 1, '@');
	g.set(39, 3, '*');
	g.line(40, 7, 44, 11, '-', 1);
	g.disc(45, 13, 1, '=');
	return g;
})();

export function BranchArt({ className }: { className?: string }) {
	return <PixelArt grid={BRANCH} label="A branch leaving main, its newest commit lit, headed for a pull request" className={className} />;
}

/** Three platters, one lit. */
const STORAGE = (() => {
	const g = new Grid(40, 21);
	for (const [index, y] of [1, 8, 15].entries()) {
		g.box(8, y, 24, 5, index === 0 ? '#' : '=');
		g.hline(11, y + 2, 10, '-');
		g.set(28, y + 2, index === 1 ? '*' : 'o');
	}
	return g;
})();

export function StorageArt({ className }: { className?: string }) {
	return <PixelArt grid={STORAGE} label="A stack of storage platters, one lit" className={className} />;
}

/** An agent at the centre, three subagents on its orbit. */
const AGENTS = (() => {
	const g = new Grid(44, 23);
	g.circle(22, 11, 9, '-', 2);
	g.box(19, 8, 7, 7, '@');
	g.fill(21, 10, 3, 3, 'o');
	g.set(22, 11, '*');
	g.box(29, 2, 5, 5, '#');
	g.box(9, 13, 5, 5, '#');
	g.box(28, 16, 5, 5, '@');
	g.set(30, 18, 'o');
	return g;
})();

export function AgentsArt({ className }: { className?: string }) {
	return <PixelArt grid={AGENTS} label="An agent with three subagents on its orbit, one at work" className={className} />;
}

/** A file's diff: lines added in green, one removed in red, the newest still being typed. */
const CHANGES = (() => {
	const g = new Grid(46, 20);
	g.box(3, 1, 40, 18, '#');
	g.hline(4, 4, 38, '-');
	const rows: Array<['g' | 'r' | '.', number, '=' | '-']> = [
		['.', 14, '-'],
		['g', 22, '='],
		['g', 17, '='],
		['r', 12, '='],
		['g', 26, '='],
		['.', 9, '-'],
	];
	rows.forEach(([mark, length, tone], index) => {
		const y = 6 + index * 2;
		if (mark !== '.') g.set(6, y, mark);
		g.hline(9, y, length, tone);
	});
	g.set(9 + 26 + 1, 14, '_');
	return g;
})();

export function ChangesArt({ className, branch, base }: { className?: string; branch?: string; base?: string }) {
	const labels: PixelLabel[] = branch ? [{ x: 9, y: 2.6, text: base ? `${base} ← ${branch}` : branch, accent: true, size: 1.6 }] : [];
	return <PixelArt grid={CHANGES} label={branch ? `A file's diff being written on ${branch}` : "A file's diff being written, line by line"} className={className} labels={labels} />;
}

/** Anton's mark, drawn at twice the size, as a sprite on the grid. */
const MARK_ROWS = ['.###.', '#...#', '##@##', '#...#', '#...#'];

function stampMark(g: Grid, x: number, y: number, scale: number) {
	MARK_ROWS.forEach((row, dy) =>
		[...row].forEach((cell, dx) => {
			if (cell === '.') return;
			g.fill(x + dx * scale, y + dy * scale, scale, scale, cell === '@' ? '@' : '#');
		}),
	);
}

/** Anton on the left, your plan on the right, and the line between them: running when linked, broken when not. */
function planLink(linked: boolean) {
	const g = new Grid(60, 20);
	stampMark(g, 6, 3, 2);
	g.box(42, 2, 14, 12, linked ? '@' : '#');
	g.fill(45, 5, 3, 3, linked ? 'o' : '=');
	g.hline(45, 10, 8, '-');
	if (linked) g.hline(18, 8, 22, '~');
	else {
		g.hline(18, 8, 8, '-', 2);
		g.hline(32, 8, 8, '-', 2);
		g.set(29, 7, 'y').set(29, 9, 'y');
	}
	return g;
}

const PLAN_LINKED = planLink(true);
const PLAN_UNLINKED = planLink(false);

export function PlanLinkArt({ className, linked, plan, noun = 'plan' }: { className?: string; linked: boolean; plan: string; noun?: 'plan' | 'account' }) {
	return (
		<PixelArt
			grid={linked ? PLAN_LINKED : PLAN_UNLINKED}
			label={linked ? `Anton linked to your ${plan} ${noun}` : `Anton, with your ${plan} ${noun} not connected yet`}
			className={className}
			labels={[
				{ x: 11, y: 18, text: 'Anton', anchor: 'middle' },
				{ x: 49, y: 17.5, text: plan, anchor: 'middle', accent: linked },
			]}
		/>
	);
}

/** A row of ports, a plug lined up over one of them. */
const LINK = (() => {
	const g = new Grid(44, 20);
	for (const x of [5, 14, 23, 32]) {
		g.box(x, 13, 7, 5, '=');
		g.hline(x + 2, 15, 3, '-');
	}
	g.box(24, 1, 5, 5, '@');
	g.fill(25, 2, 3, 3, 'o');
	g.vline(26, 6, 6, '~');
	g.set(26, 15, '*');
	return g;
})();

export function LinkArt({ className }: { className?: string }) {
	return <PixelArt grid={LINK} label="A row of ports with a plug lined up to one" className={className} />;
}

/** A dial with its hand back at twelve, and the arrow that winds it there. */
const HISTORY = (() => {
	const g = new Grid(40, 21);
	g.circle(20, 10, 8, '#');
	for (const [x, y] of [
		[20, 3],
		[27, 10],
		[20, 17],
		[13, 10],
	])
		g.set(x, y, '-');
	g.vline(20, 5, 6, '@');
	g.line(20, 10, 24, 12, '=');
	g.stamp(6, 1, ['..@', '.@@', '@@@', '.@@', '..@']);
	g.hline(9, 3, 3, '-');
	return g;
})();

export function HistoryArt({ className }: { className?: string }) {
	return <PixelArt grid={HISTORY} label="A dial wound back to its start" className={className} />;
}

/** Files on a shelf, one lifted out. */
const LIBRARY = (() => {
	const g = new Grid(46, 22);
	const tile = (x: number, y: number, lit: boolean) => {
		g.box(x, y, 8, 9, lit ? '@' : '=');
		g.hline(x + 2, y + 3, 4, lit ? 'o' : '-');
		g.hline(x + 2, y + 5, 3, lit ? 'o' : '-');
	};
	tile(6, 11, false);
	tile(16, 11, false);
	tile(26, 8, true);
	tile(36, 11, false);
	tile(11, 1, false);
	tile(21, 1, false);
	g.hline(3, 21, 41, '#');
	g.set(30, 6, '*');
	return g;
})();

export function LibraryArt({ className }: { className?: string }) {
	return <PixelArt grid={LIBRARY} label="Files on a shelf, one lifted out" className={className} />;
}

/* ——— Routes: four stations on a line, lit in turn ——— */

const CENTRES = [10, 30, 50, 70];

function route(sprites: Sprite[], lit?: boolean[]) {
	const g = new Grid(80, 13);
	for (let index = 0; index < 3; index++) g.hline(CENTRES[index] + 6, 6, CENTRES[index + 1] - CENTRES[index] - 11, '-', 2);
	sprites.forEach((sprite, index) => {
		const c = CENTRES[index];
		const on = lit ? lit[index] : true;
		g.box(c - 5, 1, 11, 11, on && lit ? '@' : '#');
		g.stamp(c - 2, 4, on ? [...SPRITE[sprite]] : dim(SPRITE[sprite]));
	});
	return g;
}

const STAGES: Array<[number, number]> = CENTRES.map((c) => [c - 5, c + 5]);
const TASK_ROUTE = route(['read', 'branch', 'terminal', 'pull']);
const CHAT_ROUTE = route(['ask', 'globe', 'terminal', 'answer']);
const PROJECT_ROUTE = route(['plan', 'threads', 'review', 'done']);

export function TaskRouteArt({ className }: { className?: string }) {
	return <PixelArt grid={TASK_ROUTE} stages={STAGES} label="A task's route: read, branch, sandbox, pull request" className={className} />;
}

export function ChatRouteArt({ className }: { className?: string }) {
	return <PixelArt grid={CHAT_ROUTE} stages={STAGES} label="A chat's route: ask, browse, scratch sandbox, answer" className={className} />;
}

/** The project's route; `active` lights the stages that are under way instead of taking turns. */
export function ProjectRouteArt({ className, active }: { className?: string; active?: boolean[]; waiting?: boolean }) {
	return active ? (
		<PixelArt grid={route(['plan', 'threads', 'review', 'done'], active)} label="A project's route: plan, threads, review, done" className={className} />
	) : (
		<PixelArt grid={PROJECT_ROUTE} stages={STAGES} label="A project's route: plan, threads, review, done" className={className} />
	);
}

/* ——— The mark ——— */

/**
 * Anton's mark: an A set in five-by-five pixels, its crossbar's middle pixel lit,
 * the one signal on the sky's grid. Hovered, the lit pixel blinks
 * (`.anton-logo` in instrument.css). The favicon and app icons are drawn from the
 * same rows (scripts/make-icons.ts); keep the two in step.
 */
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
	// Small marks draw solid pixels, so the A stays one shape; large ones show the mesh between them.
	const inset = size >= 40 ? 0.06 : 0;
	return (
		<svg aria-hidden width={size} height={size} viewBox="0 0 5 5" className={cn('anton-logo shrink-0', className)} shapeRendering="crispEdges">
			{MARK_ROWS.flatMap((row, y) =>
				[...row].map((cell, x) =>
					cell === '.' ? null : (
						<rect
							key={`${x},${y}`}
							x={x + inset}
							y={y + inset}
							width={1 - inset * 2}
							height={1 - inset * 2}
							className={cell === '@' ? 'al-signal' : undefined}
							fill={cell === '@' ? 'var(--accent-base)' : 'var(--text-primary)'}
						/>
					),
				),
			)}
		</svg>
	);
}
