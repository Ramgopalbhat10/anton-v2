import { Check, GitPullRequest, ListTodo, type LucideIcon, Rows3 } from 'lucide-react';
import { type CSSProperties, createContext, type ReactNode, useContext, useId } from 'react';
import { cn } from '@/lib/utils';

/*
 * Anton's illustrations, drawn the way the rack is: flat trays and slim tiles,
 * soft white on near-black with a hairline edge, short rules for a label, and
 * a single light. The one accent marks what is lit or at work; everything else
 * stays grey, so a drawing sits in an empty state without shouting. Wires run
 * between parts and carry a slow dashed flow when something is moving.
 */

/* ——— Parts ——— */

const EDGE = 'rgba(255, 255, 255, 0.09)';
const RULE = 'rgba(255, 255, 255, 0.16)';
const RULE_FAINT = 'rgba(255, 255, 255, 0.08)';
const WIRE = 'rgba(255, 255, 255, 0.16)';
const ACCENT = 'var(--accent)';

/** The drawing's own gradient ids, so two drawings on a page never share them. */
const Ids = createContext('art');

function Art({ w, h, label, className, children }: { w: number; h: number; label: string; className?: string; children: ReactNode }) {
	const id = `fa${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
	return (
		<svg role="img" aria-label={label} viewBox={`0 0 ${w} ${h}`} width={w} height={h} fill="none" className={cn('fa-art block h-auto max-w-full overflow-visible', className)}>
			<defs>
				<linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" style={{ stopColor: '#fff', stopOpacity: 0.1 }} />
					<stop offset="1" style={{ stopColor: '#fff', stopOpacity: 0.035 }} />
				</linearGradient>
				<linearGradient id={`${id}-lit`} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" style={{ stopColor: 'var(--a-300)', stopOpacity: 0.34 }} />
					<stop offset="1" style={{ stopColor: 'var(--a-300)', stopOpacity: 0.1 }} />
				</linearGradient>
				<radialGradient id={`${id}-glow`} cx="0.5" cy="0.5" r="0.5">
					<stop offset="0" style={{ stopColor: 'var(--accent)', stopOpacity: 0.28 }} />
					<stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
				</radialGradient>
				<linearGradient id={`${id}-screen`} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" style={{ stopColor: '#000', stopOpacity: 0.5 }} />
					<stop offset="1" style={{ stopColor: '#000', stopOpacity: 0.28 }} />
				</linearGradient>
			</defs>
			<Ids.Provider value={id}>{children}</Ids.Provider>
		</svg>
	);
}

/** A shallow tray that tiles stand in. */
function Tray({ x, y, w, h, r = 10 }: { x: number; y: number; w: number; h: number; r?: number }) {
	return <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx={r} fill="rgba(255, 255, 255, 0.025)" stroke="rgba(255, 255, 255, 0.07)" />;
}

/** An empty slot in a tray. */
function Slot({ x, y, w, h, r = 4 }: { x: number; y: number; w: number; h: number; r?: number }) {
	return <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx={r} stroke="rgba(255, 255, 255, 0.11)" strokeDasharray="1.5 2.5" />;
}

/** A tile: soft white, or lit in the accent, with a hairline all round. */
function Tile({ x, y, w, h, r = 4, lit, className, style }: { x: number; y: number; w: number; h: number; r?: number; lit?: boolean; className?: string; style?: CSSProperties }) {
	const id = useContext(Ids);
	return (
		<g className={className} style={style}>
			<rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx={r} fill={`url(#${id}-${lit ? 'lit' : 'tile'})`} stroke={lit ? 'var(--accent-line)' : EDGE} />
		</g>
	);
}

/** A recessed screen, darker than the tile it is set in. */
function Screen({ x, y, w, h, r = 5 }: { x: number; y: number; w: number; h: number; r?: number }) {
	const id = useContext(Ids);
	return <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx={r} fill={`url(#${id}-screen)`} stroke={EDGE} />;
}

/** A soft pool of the accent behind something lit. */
function Glow({ cx, cy, r }: { cx: number; cy: number; r: number }) {
	const id = useContext(Ids);
	return <circle cx={cx} cy={cy} r={r} fill={`url(#${id}-glow)`} />;
}

/** A meter of a few cells, `level` of them lit (or grey when the unit is off). */
function Meter({ x, y, cells = 8, level, on }: { x: number; y: number; cells?: number; level: number; on: boolean }) {
	return (
		<g>
			{Array.from({ length: cells }, (_, index) => (
				<rect
					key={index}
					x={x + index * 5}
					y={y}
					width={3.5}
					height={6}
					rx={0.8}
					fill={index < level ? (on ? ACCENT : 'var(--text-4)') : 'rgba(255, 255, 255, 0.07)'}
					fillOpacity={index < level && on ? 0.55 + (index / cells) * 0.45 : 1}
				/>
			))}
		</g>
	);
}

/** Short rules, like the label on a drive. */
function Rules({ x, y, w, n = 3, gap = 3.5, faint, lit }: { x: number; y: number; w: number | number[]; n?: number; gap?: number; faint?: boolean; lit?: boolean }) {
	const widths = Array.isArray(w) ? w : Array.from({ length: n }, () => w);
	return (
		<g stroke={lit ? 'var(--a-200)' : faint ? RULE_FAINT : RULE} strokeOpacity={lit ? 0.7 : 1}>
			{widths.map((width, index) => (
				<line key={index} x1={x} x2={x + width} y1={y + index * gap + 0.5} y2={y + index * gap + 0.5} />
			))}
		</g>
	);
}

/** A tile's light: grey, lit, or lit and pulsing while it works. */
function Light({ x, y, size = 5, on, live }: { x: number; y: number; size?: number; on?: boolean; live?: boolean }) {
	return <rect x={x - size / 2} y={y - size / 2} width={size} height={size} rx={1} fill={on || live ? ACCENT : 'var(--track)'} className={live ? 'in-pulse' : undefined} />;
}

/** A wire between parts; lit ones carry a slow dashed flow. */
function Wire({ d, lit, broken }: { d: string; lit?: boolean; broken?: boolean }) {
	return lit ? (
		<g>
			<path d={d} stroke="var(--accent-line)" strokeLinecap="round" />
			<path d={d} stroke={ACCENT} strokeDasharray="3 3" className="fa-flow" />
		</g>
	) : (
		<path d={d} stroke={WIRE} strokeDasharray={broken ? '2 3' : undefined} strokeLinecap="round" />
	);
}

function Caption({ x, y, children, accent, anchor = 'start' }: { x: number; y: number; children: ReactNode; accent?: boolean; anchor?: 'start' | 'middle' | 'end' }) {
	return (
		<text x={x} y={y} textAnchor={anchor} fontFamily="var(--font)" fontSize={9} letterSpacing="0.02em" fill={accent ? 'var(--accent-text)' : 'var(--text-3)'}>
			{children}
		</text>
	);
}

/** A slim tile standing in a tray, as on the rack: rules near the top, a light at the foot. */
function Blade({ x, y, h = 56, lit, live, on }: { x: number; y: number; h?: number; lit?: boolean; live?: boolean; on?: boolean }) {
	return (
		<g>
			<Tile x={x} y={y} w={15} h={h} lit={lit} />
			<Rules x={x + 4} y={y + 7} w={7} lit={lit} gap={3} />
			<Light x={x + 7.5} y={y + h - 8} on={on} live={live} />
		</g>
	);
}

/* ——— Empty and quiet states ——— */

/** A tray of slots, the first few filled and the next one arriving, lit. */
export function TasksArt({ className }: { className?: string }) {
	const xs = Array.from({ length: 8 }, (_, index) => 26 + index * 22);
	return (
		<Art w={220} h={104} label="A rack of task tiles, the next one arriving" className={className}>
			<Tray x={12} y={20} w={196} h={76} />
			{xs.map((x, index) =>
				index < 3 ? <Blade key={x} x={x} y={32} /> : index === 3 ? <Blade key={x} x={x} y={24} lit live /> : <Slot key={x} x={x} y={32} w={15} h={56} />,
			)}
		</Art>
	);
}

/** A coordinator wired to three threads, one of them at work: a project. */
export function ProjectArt({ className }: { className?: string }) {
	return (
		<Art w={240} h={124} label="A coordinator wired to three threads running side by side" className={className}>
			<Wire d="M120 38 V54 H58 V76" />
			<Wire d="M120 38 V76" lit />
			<Wire d="M120 54 H182 V76" />
			<Tile x={88} y={10} w={64} h={28} r={6} lit />
			<Rules x={98} y={18} w={[26, 18]} lit gap={4} />
			<Light x={140} y={24} on />
			<Caption x={160} y={27}>
				coordinator
			</Caption>
			{[38, 100, 162].map((x, index) => (
				<g key={x}>
					<Tile x={x} y={76} w={40} h={34} r={5} />
					<Rules x={x + 8} y={85} w={[18, 12]} gap={4} />
					<Light x={x + 32} y={102} live={index === 1} />
				</g>
			))}
		</Art>
	);
}

/**
 * A sandbox: a terminal window wired to the compute unit it runs on, whose
 * meters (processor, memory, disk) and light say its state. Lit and at work
 * when ready or running; grey and still when idle or stopped.
 */
export function SandboxArt({ className, label = 'idle' }: { className?: string; label?: string }) {
	const on = label === 'ready' || label === 'running';
	const prompt = on ? ACCENT : 'var(--text-4)';
	return (
		<Art w={260} h={116} label={`A terminal on a compute unit, ${label}`} className={className}>
			{on ? <Glow cx={208} cy={58} r={56} /> : null}
			{/* The terminal. */}
			<Tile x={10} y={10} w={150} h={96} r={9} />
			{[21, 28, 35].map((x) => (
				<circle key={x} cx={x} cy={21} r={2} fill={RULE} />
			))}
			<Rules x={64} y={20.5} w={[42]} n={1} faint />
			<Screen x={16} y={30} w={138} h={70} />
			<path d="M24 41 l3.5 3 l-3.5 3" stroke={prompt} strokeLinecap="round" strokeLinejoin="round" />
			<Rules x={33} y={43.5} w={[46]} n={1} />
			<Rules x={24} y={55} w={[104, 82, 94, 60]} faint gap={6} />
			<path d="M24 82 l3.5 3 l-3.5 3" stroke={prompt} strokeLinecap="round" strokeLinejoin="round" />
			<rect x={33} y={81.5} width={5} height={8} rx={1} fill={on ? ACCENT : 'var(--track)'} className={on ? 'fa-blink' : undefined} />
			{/* Two leads to the unit. */}
			<Wire d="M160 46 H180" lit={on} broken={!on} />
			<Wire d="M160 70 H180" lit={on} broken={!on} />
			{/* The compute unit. */}
			<Tile x={180} y={14} w={68} h={88} r={9} lit={on} />
			<Rules x={190} y={24} w={[22, 14]} gap={4} lit={on} />
			<Light x={238} y={26} on={on} live={on} />
			{(
				[
					['cpu', on ? 6 : 1],
					['mem', on ? 4 : 2],
					['disk', on ? 3 : 3],
				] as const
			).map(([name, level], index) => (
				<g key={name}>
					<text x={190} y={46 + index * 14} fontFamily="var(--font)" fontSize={6.5} letterSpacing="0.04em" fill="var(--text-4)">
						{name}
					</text>
					<Meter x={208} y={40.5 + index * 14} cells={7} level={level} on={on} />
				</g>
			))}
			<line x1={190} x2={238} y1={84.5} y2={84.5} stroke={on ? 'var(--accent-line)' : EDGE} />
			<Caption x={214} y={96} anchor="middle" accent={on}>
				{label}
			</Caption>
		</Art>
	);
}

/** A branch leaving main and heading for a pull request, its newest commit lit. */
export function BranchArt({ className }: { className?: string }) {
	const commit = (x: number, y: number, lit?: boolean) => <rect key={`${x}-${y}`} x={x - 3.5} y={y - 3.5} width={7} height={7} rx={2} fill={lit ? ACCENT : 'var(--bg-active)'} stroke={lit ? 'var(--accent-line)' : 'rgba(255,255,255,0.22)'} />;
	return (
		<Art w={250} h={96} label="A branch leaving main, its newest commit lit, headed for a pull request" className={className}>
			<Wire d="M10 70 H240" />
			<Wire d="M64 70 C 80 70, 82 38, 100 38 H170" lit />
			<Wire d="M206 50 V70" broken />
			{commit(30, 70)}
			{commit(64, 70)}
			{commit(120, 70)}
			{commit(222, 70)}
			{commit(112, 38)}
			{commit(140, 38)}
			{commit(166, 38, true)}
			<Tile x={176} y={24} w={44} h={26} r={6} lit />
			<Rules x={185} y={32} w={[24, 16]} lit gap={4} />
			<Caption x={10} y={88}>
				main
			</Caption>
		</Art>
	);
}

/** Storage: three drives in a stack, the middle one at work. */
export function StorageArt({ className }: { className?: string }) {
	return (
		<Art w={200} h={108} label="A stack of storage drives, one lit" className={className}>
			{[12, 42, 72].map((y, index) => (
				<g key={y}>
					<Tile x={30} y={y} w={140} h={24} r={5} lit={index === 1} />
					<Rules x={42} y={y + 8} w={[46, 30]} gap={4} lit={index === 1} />
					{[120, 128, 136].map((x) => (
						<line key={x} x1={x} x2={x} y1={y + 7} y2={y + 17} stroke={RULE_FAINT} />
					))}
					<Light x={156} y={y + 12} on={index === 1} live={index === 1} />
				</g>
			))}
		</Art>
	);
}

/** An agent with three subagents wired to it, one of them at work. */
export function AgentsArt({ className }: { className?: string }) {
	const subs: Array<[number, number, boolean]> = [
		[36, 18, false],
		[184, 14, false],
		[180, 72, true],
	];
	return (
		<Art w={240} h={112} label="An agent with three subagents wired to it, one at work" className={className}>
			<Wire d="M100 50 H74 V31 H62" />
			<Wire d="M140 46 H160 V27 H184" />
			<Wire d="M140 62 H160 V85 H180" lit />
			<Tile x={100} y={34} w={40} h={40} r={7} lit />
			<Rules x={109} y={45} w={[22, 14, 18]} lit gap={4} />
			<Light x={131} y={65} on />
			{subs.map(([x, y, live]) => (
				<g key={`${x}-${y}`}>
					<Tile x={x} y={y} w={26} h={26} r={5} />
					<Rules x={x + 6} y={y + 8} w={[12, 8]} gap={4} />
					<Light x={x + 19} y={y + 19} size={4} live={live} />
				</g>
			))}
		</Art>
	);
}

const shortName = (name: string, max = 34) => (name.length > max ? `${name.slice(0, max - 1)}…` : name);

/** A file's diff being written, line by line, on the task's branch. */
export function ChangesArt({ className, branch, base }: { className?: string; branch?: string; base?: string }) {
	const rows: Array<[number, 'add' | 'keep' | 'drop']> = [
		[110, 'keep'],
		[150, 'add'],
		[124, 'add'],
		[86, 'drop'],
		[138, 'keep'],
	];
	return (
		<Art w={260} h={120} label={branch ? `A file's diff being written on ${branch}` : "A file's diff being written, line by line"} className={className}>
			<Tile x={10} y={8} w={240} h={104} r={8} />
			{branch ? (
				<Caption x={22} y={24} accent>
					{shortName(base ? `${base} ← ${branch}` : branch)}
				</Caption>
			) : (
				<Rules x={22} y={20} w={[70]} n={1} />
			)}
			<line x1={11} x2={249} y1={32.5} y2={32.5} stroke={EDGE} />
			{rows.map(([width, kind], index) => {
				const y = 44 + index * 12;
				return (
					<g key={y}>
						<rect x={20} y={y - 4} width={2} height={9} rx={1} fill={kind === 'add' ? ACCENT : kind === 'drop' ? 'var(--text-4)' : 'transparent'} />
						<Rules x={30} y={y} w={[width]} n={1} faint={kind === 'keep'} lit={kind === 'add'} />
					</g>
				);
			})}
			<rect x={30} y={101} width={5} height={7} rx={1} fill={ACCENT} className="fa-blink" transform="translate(0 -4)" />
		</Art>
	);
}

/** The mark's facets, for drawing Anton inside an illustration. */
function MarkShapes() {
	return (
		<>
			<polygon points="12,6 19.1,10.1 12,14.2 4.9,10.1" fill="#9EE1F3" />
			<polygon points="4.9,10.1 12,14.2 12,22.4 4.9,18.3" fill="#3FB6D8" />
			<polygon points="12,14.2 19.1,10.1 19.1,18.3 12,22.4" fill="#17627A" />
			<path d="M7.03 14.28v2.13M9.87 15.92v2.13" stroke="#06181F" strokeWidth="1.75" strokeLinecap="round" />
		</>
	);
}

/**
 * Anton on the left, your plan on the right (its vendor's logo when there is
 * one), joined through a key in the middle: lit, with the wire carrying a flow
 * both ways, when you are signed in; open, the plug pulled, when you are not.
 */
export function PlanLinkArt({ className, linked, plan, noun = 'plan', logo }: { className?: string; linked: boolean; plan: string; noun?: 'plan' | 'account'; logo?: string }) {
	return (
		<Art w={280} h={112} label={linked ? `Anton linked to your ${plan} ${noun}` : `Anton, with your ${plan} ${noun} not connected yet`} className={className}>
			{linked ? (
				<>
					<Glow cx={140} cy={46} r={70} />
					<Wire d="M86 46 H124" lit />
					<Wire d="M156 46 H194" lit />
				</>
			) : (
				<>
					<Wire d="M86 46 H118" broken />
					<Wire d="M162 46 H194" broken />
				</>
			)}
			{/* The key between them: a check when signed in, an open plug when not. */}
			{linked ? (
				<g>
					<rect x={124.5} y={34.5} width={31} height={23} rx={11.5} fill="var(--accent-soft)" stroke="var(--accent-line)" />
					<path d="M133.5 46 l4 4 l9 -8.5" stroke="var(--accent-text)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
				</g>
			) : (
				<g>
					<rect x={118.5} y={40.5} width={13} height={11} rx={2.5} fill="var(--bg-active)" stroke={EDGE} />
					<line x1={131} x2={135} y1={43.5} y2={43.5} stroke="var(--text-4)" strokeLinecap="round" />
					<line x1={131} x2={135} y1={48.5} y2={48.5} stroke="var(--text-4)" strokeLinecap="round" />
					<rect x={148.5} y={40.5} width={13} height={11} rx={2.5} fill="none" stroke="rgba(255, 255, 255, 0.14)" strokeDasharray="2 2" />
				</g>
			)}
			{/* Anton. */}
			<Tile x={30} y={18} w={56} h={56} r={12} lit={linked} />
			<g transform="translate(40 28) scale(2.15) translate(-3.5 -5.7)">
				<MarkShapes />
			</g>
			{/* The plan. */}
			<Tile x={194} y={18} w={56} h={56} r={12} lit={linked} />
			{logo ? (
				// The vendor's own logo, as its tab shows it; one-colour logos take the text colour.
				<foreignObject x={194} y={18} width={56} height={56}>
					<div
						aria-hidden
						className={cn('flex size-full items-center justify-center text-[28px] [&_svg]:block', linked ? 'text-(--text)' : 'text-(--text-3)')}
						dangerouslySetInnerHTML={{ __html: logo }}
					/>
				</foreignObject>
			) : (
				<>
					<Rules x={206} y={32} w={[28, 20, 24]} gap={5} lit={linked} />
					<Light x={238} y={62} on={linked} />
				</>
			)}
			<Caption x={58} y={92} anchor="middle">
				Anton
			</Caption>
			<Caption x={140} y={76} anchor="middle" accent={linked}>
				{linked ? 'signed in' : 'not connected'}
			</Caption>
			<Caption x={222} y={92} anchor="middle" accent={linked}>
				{shortName(plan, 18)}
			</Caption>
		</Art>
	);
}

/** A row of ports, a plug lined up over one of them. */
export function LinkArt({ className }: { className?: string }) {
	return (
		<Art w={220} h={100} label="A row of ports with a plug lined up to one" className={className}>
			<Tray x={14} y={56} w={192} h={34} r={9} />
			<Wire d="M133 34 V64" lit />
			{[30, 74, 118, 162].map((x) => (
				<g key={x}>
					<rect x={x + 0.5} y={64.5} width={29} height={17} rx={4} fill="rgba(0,0,0,0.35)" stroke={EDGE} />
					<line x1={x + 9} x2={x + 21} y1={73.5} y2={73.5} stroke={x === 118 ? ACCENT : RULE_FAINT} />
				</g>
			))}
			<Tile x={118} y={10} w={30} h={24} r={5} lit />
			<Rules x={125} y={18} w={[16, 10]} gap={4} lit />
		</Art>
	);
}

/** Saved states of the files in a row, an earlier one lifted out to look at. */
export function HistoryArt({ className }: { className?: string }) {
	const xs = [24, 56, 88, 120, 152, 184];
	return (
		<Art w={232} h={104} label="Saved states of the files in a row, an earlier one lifted out" className={className}>
			<line x1={14} x2={218} y1={92.5} y2={92.5} stroke={WIRE} />
			{xs.map((x, index) => (
				<g key={x}>
					<line x1={x + 12} x2={x + 12} y1={89} y2={96} stroke={index === 2 ? ACCENT : WIRE} />
					<g opacity={index === 2 ? 1 : 0.45 + index * 0.1}>
						<Tile x={x} y={index === 2 ? 14 : 26} w={24} h={52} r={4} lit={index === 2} />
						<Rules x={x + 5} y={(index === 2 ? 14 : 26) + 8} w={[14, 10, 12]} gap={4} lit={index === 2} />
					</g>
				</g>
			))}
			<Light x={196} y={70} on live />
		</Art>
	);
}

/** Files on a shelf, one lifted out. */
export function LibraryArt({ className }: { className?: string }) {
	const files: Array<[number, number, number]> = [
		[28, 22, 48],
		[54, 26, 56],
		[84, 20, 42],
		[108, 30, 52],
		[142, 22, 46],
		[168, 26, 54],
	];
	return (
		<Art w={220} h={104} label="Files on a shelf, one lifted out" className={className}>
			<Tray x={14} y={28} w={192} h={68} />
			{files.map(([x, w, h], index) => {
				const lifted = index === 3;
				const y = 88 - h - (lifted ? 14 : 0);
				return (
					<g key={x}>
						<Tile x={x} y={y} w={w} h={h} r={4} lit={lifted} />
						<Rules x={x + 5} y={y + 8} w={[w - 10, w - 14]} gap={4} lit={lifted} />
					</g>
				);
			})}
		</Art>
	);
}

/* ——— The project's route: four stations on a wire, lit in turn ——— */

const STATIONS: Array<{ icon: LucideIcon }> = [{ icon: ListTodo }, { icon: Rows3 }, { icon: GitPullRequest }, { icon: Check }];

/** The project's route; `active` lights the stages that are under way instead of taking turns. */
export function ProjectRouteArt({ className, active }: { className?: string; active?: boolean[]; waiting?: boolean }) {
	const centres = [50, 150, 250, 350];
	return (
		<Art w={400} h={60} label="A project's route: plan, threads, review, done" className={className}>
			{[0, 1, 2].map((index) => (
				<Wire key={index} d={`M${centres[index] + 24} 30 H${centres[index + 1] - 24}`} broken />
			))}
			{STATIONS.map(({ icon: Glyph }, index) => {
				const x = centres[index] - 22;
				const lit = active?.[index];
				return (
					<g key={index}>
						<Tile x={x} y={8} w={44} h={44} r={9} />
						<Glyph x={x + 14} y={22} width={16} height={16} strokeWidth={1.6} color="var(--text-3)" />
						<g
							className={active ? undefined : 'fa-stage'}
							data-first={index === 0 ? true : undefined}
							style={{ '--stage': index, opacity: active ? (lit ? 1 : 0) : undefined } as CSSProperties}
						>
							<Tile x={x} y={8} w={44} h={44} r={9} lit />
							<Glyph x={x + 14} y={22} width={16} height={16} strokeWidth={1.6} color="var(--a-200)" />
						</g>
					</g>
				);
			})}
		</Art>
	);
}

/* ——— The mark ——— */

/**
 * Anton's mark: a ring and its centre on a tile of the accent. The favicon
 * and app icons are drawn from the same shapes (scripts/make-icons.ts); keep
 * the two in step.
 */
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
	return (
		<svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className={cn('shrink-0', className)}>
			<rect x="1" y="1" width="22" height="22" rx="6" fill="var(--accent)" />
			<circle cx="12" cy="12" r="5.2" fill="none" stroke="#FFFFFF" strokeWidth="2" />
			<circle cx="12" cy="12" r="1.8" fill="#FFFFFF" />
		</svg>
	);
}
