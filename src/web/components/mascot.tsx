import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Anton's mascot: the sandbox cube from the app's drawings, in pixels, on
 * two legs, with an antenna whose light says what the agent does. It sits
 * on the composer's top edge. Each mood is a pose plus a few CSS loops
 * (`.anton-mascot` in instrument.css); with reduced motion only the pose stays.
 */
export type MascotMood = 'idle' | 'working' | 'waiting' | 'done' | 'sleeping';

/** One letter per grid pixel, x from the left, y from the top of the body; `.` is empty. */
const TORSO = [
	'..TTTTTTTTTT..',
	'.TTTTTTTTTTTH.',
	'.FFFFFFFFFFFD.',
	'.FFFFFFFFFFFD.',
	'.FFFFFFFFFFFD.',
	'.FFFFFFFFFFFD.',
	'.FFFFFFFFFFFD.',
	'.FFFFFFFFFFFD.',
	'.FFFFF..FFFFD.',
];
const FILL: Record<string, string> = {
	T: 'var(--cyan-200)',
	H: 'var(--cyan-300)',
	F: 'var(--cyan-400)',
	D: 'var(--cyan-600)',
};
const INK = '#06181F';

type Px = [x: number, y: number];

/** Each pixel once, as runs along a row, so a pose is a handful of rects. */
function Pixels({ px, fill, className }: { px: Px[]; fill: string; className?: string }) {
	return (
		<g className={className} fill={fill}>
			{px.map(([x, y]) => (
				<rect key={`${x},${y}`} x={x} y={y} width={1.02} height={1.02} />
			))}
		</g>
	);
}

const torso = TORSO.flatMap((row, y) =>
	[...row].flatMap((cell, x) => (cell === '.' ? [] : [{ x, y, fill: FILL[cell]! }])),
);
const EYES: Px[] = [[4, 4], [4, 5], [9, 4], [9, 5]];
const HAPPY: Px[] = [[4, 4], [3, 5], [5, 5], [9, 4], [8, 5], [10, 5]];
const SHUT: Px[] = [[3, 5], [4, 5], [9, 5], [10, 5]];
const QUESTION: Px[] = [[1, -6], [2, -6], [3, -6], [3, -5], [2, -4], [2, -2]];
const ZZZ: Px[] = [[12, -6], [13, -6], [14, -6], [13, -5], [12, -4], [13, -4], [14, -4]];
const SPARK: Px[] = [[1, -4], [0, -3], [1, -3], [2, -3], [1, -2]];

/** How far it wanders while working, in grid pixels from where it stands: mostly left, along the composer. */
const ROAM_LEFT = 48;
const ROAM_RIGHT = 6;
/** Each grid pixel of a walk takes this long, so a long walk takes longer. */
const STEP_MS = 85;
const between = (low: number, high: number) => low + Math.random() * (high - low);

/**
 * While working, it walks to a spot along the composer's edge, stands a
 * while, and walks on, and now and then hops on the spot: chosen at random,
 * so it never loops. Otherwise it walks back to where it stands. Reduced
 * motion keeps it still.
 */
function useRoam(working: boolean) {
	const [walk, setWalk] = useState({ x: 0, ms: 0, walking: false });
	const [hop, setHop] = useState(0);
	useEffect(() => {
		if (!working || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			setWalk((current) => (current.x === 0 ? current : { x: 0, ms: Math.abs(current.x) * STEP_MS, walking: true }));
			return;
		}
		let x = 0;
		let timer: ReturnType<typeof setTimeout>;
		const next = () => {
			// A new spot at least a few pixels away, so every walk reads as one.
			let to = x;
			while (Math.abs(to - x) < 4) to = Math.round(between(-ROAM_LEFT, ROAM_RIGHT));
			const ms = Math.abs(to - x) * STEP_MS;
			x = to;
			setWalk({ x, ms, walking: true });
			timer = setTimeout(next, ms + between(900, 2600));
		};
		timer = setTimeout(next, between(400, 1200));
		return () => clearTimeout(timer);
	}, [working]);
	useEffect(() => {
		if (!working || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		let timer: ReturnType<typeof setTimeout>;
		const next = () => {
			setHop((count) => count + 1);
			timer = setTimeout(next, between(1800, 5200));
		};
		timer = setTimeout(next, between(1200, 3000));
		return () => clearTimeout(timer);
	}, [working]);
	const halt = useCallback(() => setWalk((current) => (current.walking ? { ...current, walking: false } : current)), []);
	return { walk, halt, hop: working ? hop : 0 };
}

export function Mascot({ mood, className }: { mood: MascotMood; className?: string }) {
	const { walk, halt, hop } = useRoam(mood === 'working');
	return (
		<svg
			aria-hidden
			viewBox="0 -7 14 17"
			width={35}
			height={42.5}
			shapeRendering="crispEdges"
			data-mood={mood}
			className={`anton-mascot ${className ?? ''}`}
		>
			<g
				className="am-roam"
				data-walking={walk.walking || undefined}
				style={{ transform: `translateX(${walk.x}px)`, transition: walk.ms ? `transform ${walk.ms}ms steps(${Math.round(walk.ms / STEP_MS)}, end)` : undefined }}
				onTransitionEnd={(event) => {
					if (event.target === event.currentTarget) halt();
				}}
			>
				{/* Keyed by the hop, so each one plays its animation afresh. */}
				<g key={hop} className={hop ? 'am-hopper' : undefined}>
					<Pixels className="am-question" px={QUESTION} fill="var(--amber-400)" />
					<g className="am-zzz">
						<Pixels className="am-z" px={ZZZ} fill="var(--cyan-200)" />
						<Pixels className="am-z am-z2" px={ZZZ} fill="var(--cyan-200)" />
					</g>
					<Pixels className="am-spark" px={SPARK} fill="var(--cyan-200)" />
					<g className="am-body">
						<g className="am-upper">
							<rect className="am-stalk" x={10} y={-1} width={1.02} height={1.02} fill="var(--neutral-500)" />
							<rect className="am-led" x={10} y={-2} width={1.02} height={1.02} />
							{torso.map(({ x, y, fill }) => (
								<rect key={`${x},${y}`} x={x} y={y} width={1.02} height={1.02} fill={fill} />
							))}
							<Pixels className="am-eyes" px={EYES} fill={INK} />
							<Pixels className="am-happy" px={HAPPY} fill={INK} />
							<Pixels className="am-shut" px={SHUT} fill={INK} />
							<Pixels className="am-arm-l" px={[[0, 5], [0, 6]]} fill="var(--cyan-500)" />
							<Pixels className="am-arm-r" px={[[13, 5], [13, 6]]} fill="var(--cyan-600)" />
						</g>
						<Pixels className="am-leg-l" px={[[2, 9], [3, 9], [4, 9]]} fill="var(--cyan-700)" />
						<Pixels className="am-leg-r" px={[[9, 9], [10, 9], [11, 9]]} fill="var(--cyan-700)" />
					</g>
				</g>
			</g>
		</svg>
	);
}

/** How long the mascot stays pleased after a turn ends. */
const DONE_MS = 2400;
/** Quiet time before it nods off; anything you do (typing, a new turn) wakes it. */
const SLEEP_MS = 4 * 60_000;

/**
 * The mood from what the agent does: working while it runs, a hop when a turn
 * ends, a question while the task waits on you, and asleep after a while
 * with nothing happening. `stir` changes when you do something (a keystroke).
 */
export function useMascotMood({ busy, waiting, stir }: { busy: boolean; waiting: boolean; stir?: unknown }): MascotMood {
	const [done, setDone] = useState(false);
	const [sleeping, setSleeping] = useState(false);
	const wasBusy = useRef(busy);
	useEffect(() => {
		if (wasBusy.current && !busy) {
			setDone(true);
			const timer = setTimeout(() => setDone(false), DONE_MS);
			wasBusy.current = busy;
			return () => clearTimeout(timer);
		}
		wasBusy.current = busy;
		if (busy) setDone(false);
	}, [busy]);
	useEffect(() => {
		setSleeping(false);
		if (busy || waiting) return;
		const timer = setTimeout(() => setSleeping(true), SLEEP_MS);
		return () => clearTimeout(timer);
	}, [busy, waiting, stir]);
	if (busy) return 'working';
	if (done) return 'done';
	if (waiting) return 'waiting';
	return sleeping ? 'sleeping' : 'idle';
}
