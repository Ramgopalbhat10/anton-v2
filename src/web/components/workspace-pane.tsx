import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';

const WIDTH_KEY = 'anton.workspace-width';
const MIN_WIDTH = 360;
const CONVERSATION_WIDTH = 340;

function savedWidth(): number | null {
	try {
		const value = Number(localStorage.getItem(WIDTH_KEY));
		return Number.isFinite(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

/** One workspace width shared by Files, Changes, Terminal and the other panels. */
export function WorkspacePane({ expanded, children }: { expanded: boolean; children: ReactNode }) {
	const pane = useRef<HTMLElement>(null);
	const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
	const [available, setAvailable] = useState(0);
	const [requested, setRequested] = useState(savedWidth);
	const [resizing, setResizing] = useState(false);
	useLayoutEffect(() => {
		const parent = pane.current?.parentElement;
		if (!parent) return;
		const measure = () => setAvailable(Math.round(parent.getBoundingClientRect().width));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);

	const compact = available > 0 && available < MIN_WIDTH + CONVERSATION_WIDTH;
	const minimum = Math.min(MIN_WIDTH, available);
	const maximum = Math.max(minimum, available - CONVERSATION_WIDTH);
	const clamp = (value: number) => Math.round(Math.min(maximum, Math.max(minimum, value)));
	const width = clamp(requested ?? available * 0.46);
	function choose(value: number) {
		const next = clamp(value);
		setRequested(next);
		try {
			localStorage.setItem(WIDTH_KEY, String(next));
		} catch {
			// Resizing also works when browser storage is unavailable.
		}
	}

	return (
		<section
			ref={pane}
			className="sg-workspace relative flex min-h-0 min-w-0 flex-col border-(--border-subtle) md:border-l"
			data-expanded={expanded}
			data-compact={compact}
			data-resizing={resizing}
			style={{ '--workspace-width': available ? `${width}px` : '46%' } as CSSProperties}
		>
			{!expanded && !compact ? (
				<div
					role="separator"
					aria-label="Resize workspace"
					aria-orientation="vertical"
					aria-valuemin={minimum}
					aria-valuemax={maximum}
					aria-valuenow={width}
					aria-valuetext={`${width} pixels`}
					tabIndex={0}
					className="sg-workspace-resizer absolute inset-y-0 left-0 z-20 hidden w-1.5 cursor-col-resize touch-none outline-none md:block"
					onKeyDown={(event) => {
						const next = { ArrowLeft: width + 24, ArrowRight: width - 24, Home: minimum, End: maximum }[event.key];
						if (next === undefined) return;
						event.preventDefault();
						choose(next);
					}}
					onPointerDown={(event) => {
						if (event.button !== 0) return;
						event.preventDefault();
						event.currentTarget.focus();
						event.currentTarget.setPointerCapture(event.pointerId);
						drag.current = { pointer: event.pointerId, x: event.clientX, width };
						setResizing(true);
					}}
					onPointerMove={(event) => {
						const start = drag.current;
						if (start?.pointer === event.pointerId) choose(start.width + start.x - event.clientX);
					}}
					onPointerUp={(event) => {
						if (drag.current?.pointer !== event.pointerId) return;
						event.currentTarget.releasePointerCapture(event.pointerId);
						drag.current = null;
						setResizing(false);
					}}
					onLostPointerCapture={() => {
						drag.current = null;
						setResizing(false);
					}}
				/>
			) : null}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
		</section>
	);
}
