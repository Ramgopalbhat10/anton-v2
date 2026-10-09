import { ArrowUpRight, Circle, Minus, Pencil, Redo2, Square, Trash2, Type, Undo2 } from 'lucide-react';
import { type PointerEvent, useEffect, useRef, useState } from 'react';
import { Btn, IconBtn } from '@/components/signal';
import { cn } from '@/lib/utils';

/*
 * Drawing on a picture of the page, to show the agent what you mean: a pen,
 * lines, arrows, boxes, ellipses and text in a few colours, with undo. The
 * marks are SVG over the picture; "Add to chat" flattens both into a PNG.
 */

type Tool = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text';
type Point = { x: number; y: number };
type Mark =
	| { tool: 'pen'; color: string; points: Point[] }
	| { tool: 'line' | 'arrow' | 'rect' | 'ellipse'; color: string; from: Point; to: Point }
	| { tool: 'text'; color: string; at: Point; text: string };

const TOOLS: Array<{ tool: Tool; icon: typeof Pencil; label: string }> = [
	{ tool: 'pen', icon: Pencil, label: 'Pen' },
	{ tool: 'line', icon: Minus, label: 'Line' },
	{ tool: 'arrow', icon: ArrowUpRight, label: 'Arrow' },
	{ tool: 'rect', icon: Square, label: 'Rectangle' },
	{ tool: 'ellipse', icon: Circle, label: 'Ellipse' },
	{ tool: 'text', icon: Type, label: 'Text' },
];

const COLORS = [
	{ value: '#ef4444', label: 'Red' },
	{ value: '#3b82f6', label: 'Blue' },
	{ value: '#22c55e', label: 'Green' },
	{ value: '#111111', label: 'Black' },
	{ value: '#ffffff', label: 'White' },
];

/** Stroke width in page pixels, so marks keep their weight whatever size the picture is shown at. */
const STROKE = 3;
const FONT = 18;

function arrowHead(from: Point, to: Point): string {
	const angle = Math.atan2(to.y - from.y, to.x - from.x);
	const size = 14;
	const left = { x: to.x - size * Math.cos(angle - Math.PI / 7), y: to.y - size * Math.sin(angle - Math.PI / 7) };
	const right = { x: to.x - size * Math.cos(angle + Math.PI / 7), y: to.y - size * Math.sin(angle + Math.PI / 7) };
	return `M${left.x} ${left.y} L${to.x} ${to.y} L${right.x} ${right.y}`;
}

function MarkShape({ mark }: { mark: Mark }) {
	const stroke = { stroke: mark.color, strokeWidth: STROKE, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
	switch (mark.tool) {
		case 'pen':
			return <path d={mark.points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ')} {...stroke} />;
		case 'line':
			return <line x1={mark.from.x} y1={mark.from.y} x2={mark.to.x} y2={mark.to.y} {...stroke} />;
		case 'arrow':
			return (
				<g {...stroke}>
					<line x1={mark.from.x} y1={mark.from.y} x2={mark.to.x} y2={mark.to.y} />
					<path d={arrowHead(mark.from, mark.to)} />
				</g>
			);
		case 'rect':
			return (
				<rect
					x={Math.min(mark.from.x, mark.to.x)}
					y={Math.min(mark.from.y, mark.to.y)}
					width={Math.abs(mark.to.x - mark.from.x)}
					height={Math.abs(mark.to.y - mark.from.y)}
					rx={4}
					{...stroke}
				/>
			);
		case 'ellipse':
			return (
				<ellipse
					cx={(mark.from.x + mark.to.x) / 2}
					cy={(mark.from.y + mark.to.y) / 2}
					rx={Math.abs(mark.to.x - mark.from.x) / 2}
					ry={Math.abs(mark.to.y - mark.from.y) / 2}
					{...stroke}
				/>
			);
		case 'text':
			return (
				<text
					x={mark.at.x}
					y={mark.at.y}
					fill={mark.color}
					fontSize={FONT}
					fontWeight={600}
					fontFamily="ui-sans-serif, system-ui, sans-serif"
					stroke={mark.color === '#ffffff' ? '#111111' : '#ffffff'}
					strokeWidth={3}
					paintOrder="stroke"
					dominantBaseline="hanging"
				>
					{mark.text}
				</text>
			);
	}
}

/** The picture with the marks on it, as a PNG data URL at the picture's own size. */
async function flatten(svg: SVGSVGElement, width: number, height: number): Promise<string> {
	const markup = new XMLSerializer().serializeToString(svg);
	const image = new Image();
	image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
	await image.decode();
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
	return canvas.toDataURL('image/png');
}

/**
 * Draws over `image` (a PNG, base64) shown at the size of the area it covers.
 * `onAttach` gets the result as a PNG data URL.
 */
export function Sketch({
	image,
	width,
	height,
	onClose,
	onAttach,
}: {
	image: string;
	width: number;
	height: number;
	onClose: () => void;
	onAttach: (png: string) => void;
}) {
	const svg = useRef<SVGSVGElement>(null);
	const [tool, setTool] = useState<Tool>('pen');
	const [color, setColor] = useState(COLORS[0].value);
	const [marks, setMarks] = useState<Mark[]>([]);
	const [undone, setUndone] = useState<Mark[]>([]);
	// The shape being drawn; text goes through `typing` instead.
	const [drawing, setDrawing] = useState<Exclude<Mark, { tool: 'text' }> | null>(null);
	const [typing, setTyping] = useState<{ at: Point; text: string } | null>(null);
	const [saving, setSaving] = useState(false);

	const add = (mark: Mark) => {
		setMarks((current) => [...current, mark]);
		setUndone([]);
	};
	const undo = () => {
		const last = marks[marks.length - 1];
		if (!last) return;
		setMarks(marks.slice(0, -1));
		setUndone([last, ...undone]);
	};
	const clear = () => {
		setUndone([...marks].reverse());
		setMarks([]);
	};
	const redo = () => {
		const [next, ...rest] = undone;
		if (!next) return;
		setMarks([...marks, next]);
		setUndone(rest);
	};

	// Keys read the latest state through a ref, so the listener is added once rather than on every render.
	const keys = useRef({ typing, onClose, undo, redo });
	keys.current = { typing, onClose, undo, redo };
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const current = keys.current;
			if (current.typing) return;
			if (event.key === 'Escape') current.onClose();
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
				event.preventDefault();
				if (event.shiftKey) current.redo();
				else current.undo();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	/** The pointer in the picture's own pixels. */
	function at(event: PointerEvent): Point {
		const box = svg.current!.getBoundingClientRect();
		return { x: ((event.clientX - box.left) / box.width) * width, y: ((event.clientY - box.top) / box.height) * height };
	}

	function commitText() {
		if (typing?.text.trim()) add({ tool: 'text', color, at: typing.at, text: typing.text.trim() });
		setTyping(null);
	}

	function onPointerDown(event: PointerEvent<SVGSVGElement>) {
		if (event.button !== 0) return;
		const point = at(event);
		if (tool === 'text') {
			commitText();
			setTyping({ at: point, text: '' });
			return;
		}
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setDrawing(tool === 'pen' ? { tool, color, points: [point] } : { tool, color, from: point, to: point });
	}

	function onPointerMove(event: PointerEvent<SVGSVGElement>) {
		if (!drawing) return;
		const point = at(event);
		if (drawing.tool !== 'pen') return setDrawing({ ...drawing, to: point });
		// The stroke in progress is ours alone until it is added, so its points grow in place rather than being copied on every move.
		drawing.points.push(point);
		setDrawing({ ...drawing });
	}

	function onPointerUp() {
		if (!drawing) return;
		const tiny = drawing.tool !== 'pen' && Math.hypot(drawing.to.x - drawing.from.x, drawing.to.y - drawing.from.y) < 3;
		if (!tiny) add(drawing);
		setDrawing(null);
	}

	async function attach() {
		commitText();
		setSaving(true);
		// Wait a frame, so a text being typed is drawn before the picture is made.
		await new Promise((resolve) => requestAnimationFrame(resolve));
		try {
			onAttach(await flatten(svg.current!, width, height));
		} finally {
			setSaving(false);
		}
	}

	const box = svg.current?.getBoundingClientRect();
	return (
		<div className="absolute inset-0 z-20 flex flex-col" role="dialog" aria-label="Draw on the page">
			<div className="relative min-h-0 flex-1">
				<svg
					ref={svg}
					xmlns="http://www.w3.org/2000/svg"
					viewBox={`0 0 ${width} ${height}`}
					width={width}
					height={height}
					className={cn('absolute inset-0 size-full touch-none select-none', tool === 'text' ? 'cursor-text' : 'cursor-crosshair')}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
				>
					<image href={`data:image/png;base64,${image}`} x={0} y={0} width={width} height={height} />
					{marks.map((mark, index) => (
						<MarkShape key={index} mark={mark} />
					))}
					{drawing ? <MarkShape mark={drawing} /> : null}
				</svg>
				{typing && box ? (
					<input
						autoFocus
						aria-label="Text to add"
						value={typing.text}
						onChange={(event) => setTyping({ ...typing, text: event.target.value })}
						onKeyDown={(event) => {
							if (event.key === 'Enter') commitText();
							if (event.key === 'Escape') setTyping(null);
						}}
						onBlur={commitText}
						className="absolute z-10 min-w-[120px] rounded-[4px] border border-(--accent-border) bg-(--bg-raised) px-1.5 py-0.5 text-[13px] text-(--text-primary) outline-none"
						style={{ left: (typing.at.x / width) * box.width, top: (typing.at.y / height) * box.height }}
					/>
				) : null}
			</div>
			<div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
				<div className="in-pop pointer-events-auto flex items-center gap-0.5 p-1" role="toolbar" aria-label="Drawing tools">
					{TOOLS.map((entry) => (
						<IconBtn
							key={entry.tool}
							icon={entry.icon}
							size="sm"
							label={entry.label}
							aria-pressed={tool === entry.tool}
							onClick={() => setTool(entry.tool)}
							className={cn(tool === entry.tool && 'bg-(--accent-bg-subtle) text-(--accent-text)')}
						/>
					))}
					<span aria-hidden className="mx-1 h-4 w-px bg-(--border-subtle)" />
					<div role="radiogroup" aria-label="Colour" className="flex items-center gap-1 px-0.5">
						{COLORS.map((entry) => (
							<button
								key={entry.value}
								type="button"
								role="radio"
								aria-checked={color === entry.value}
								aria-label={entry.label}
								title={entry.label}
								onClick={() => setColor(entry.value)}
								className={cn(
									'size-[18px] rounded-full border border-(--border-strong) outline-none focus-visible:shadow-(--focus-ring)',
									color === entry.value && 'ring-2 ring-(--accent-base) ring-offset-1 ring-offset-(--pop-bg)',
								)}
								style={{ background: entry.value }}
							/>
						))}
					</div>
					<span aria-hidden className="mx-1 h-4 w-px bg-(--border-subtle)" />
					{(
						[
							[Undo2, 'Undo', undo, marks.length === 0],
							[Redo2, 'Redo', redo, undone.length === 0],
							[Trash2, 'Clear', clear, marks.length === 0],
						] as const
					).map(([icon, label, run, disabled]) => (
						<IconBtn key={label} icon={icon} size="sm" label={label} disabled={disabled} onClick={() => run()} />
					))}
					<span aria-hidden className="mx-1 h-4 w-px bg-(--border-subtle)" />
					<Btn size="sm" variant="ghost" onClick={onClose}>
						Close
					</Btn>
					<Btn size="sm" variant="primary" disabled={saving} onClick={() => void attach()}>
						{saving ? 'Adding…' : 'Add to chat'}
					</Btn>
				</div>
			</div>
		</div>
	);
}
