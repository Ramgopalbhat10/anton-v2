import { type CSSProperties, createContext, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useViewer } from '@/lib/viewer';
import { useOnePane } from '@/lib/one-pane';
import { OutputViewerDock } from '@/components/content/output-viewer';

const WIDTH_KEY = 'anton.workspace-width';
const MIN_WIDTH = 360;
const CONVERSATION_WIDTH = 340;
const NARROW_WIDTH = 248;

/** As long as `--t-panel`: how long the workspace takes to slide in or out. */
const SLIDE_MS = 300;

export type PaneSlide = 'in' | 'out' | 'still';

export const PaneSlideContext = createContext<PaneSlide>('still');

/** Null while closed, so the workspace is unmounted; kept mounted while it slides out. One open when the page first draws does not slide in. */
export function usePaneSlide(open: boolean): PaneSlide | null {
	const [slide, setSlide] = useState<PaneSlide | null>(open ? 'still' : null);
	const [lastOpen, setLastOpen] = useState(open);
	if (lastOpen !== open) {
		setLastOpen(open);
		setSlide(open ? 'in' : 'out');
	}
	useEffect(() => {
		if (slide !== 'in' && slide !== 'out') return;
		const timer = setTimeout(() => setSlide(slide === 'in' ? 'still' : null), SLIDE_MS);
		return () => clearTimeout(timer);
	}, [slide]);
	return slide;
}

function savedWidth(): number | null {
	try {
		const value = Number(localStorage.getItem(WIDTH_KEY));
		return Number.isFinite(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

/** `narrow` is the slim column it takes while no panel is chosen, so the conversation keeps the room. */
export function WorkspacePane({ expanded, closingExpanded = false, narrow = false, children }: { expanded: boolean; closingExpanded?: boolean; narrow?: boolean; children: ReactNode }) {
	const pane = useRef<HTMLElement>(null);
	const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
	const [available, setAvailable] = useState(0);
	const [requested, setRequested] = useState(savedWidth);
	const [resizing, setResizing] = useState(false);
	const slide = useContext(PaneSlideContext);
	const viewer = useViewer();
	const onePane = useOnePane();
	const viewing = Boolean(viewer) && !onePane;
	const slim = narrow && !viewing;
	const [layoutMotion, setLayoutMotion] = useState(false);
	const lastLayout = useRef({ slim, expanded });
	if (lastLayout.current.slim !== slim || lastLayout.current.expanded !== expanded) {
		lastLayout.current = { slim, expanded };
		setLayoutMotion(true);
	}
	useEffect(() => {
		if (!layoutMotion) return;
		const timer = setTimeout(() => setLayoutMotion(false), SLIDE_MS);
		return () => clearTimeout(timer);
	}, [layoutMotion, slim, expanded]);
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
	const rail = Math.min(NARROW_WIDTH, maximum);
	const width = slim ? rail : clamp(requested ?? available * 0.46);
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
			// Only beside the conversation does it slide out; covering it, it goes at once.
			className={cn(
				'sg-workspace relative flex min-h-0 min-w-0 flex-col border-(--line) md:border-l',
				slide === 'out' && (compact ? 'hidden' : 'max-md:hidden'),
			)}
			data-expanded={expanded}
			data-compact={compact}
			data-resizing={resizing}
			data-narrow={narrow}
			data-slide={slide}
			data-layout-motion={layoutMotion}
			data-closing-expanded={closingExpanded}
			style={{ '--workspace-width': available ? `${width}px` : '46%', '--workspace-expanded-width': available ? `${available}px` : '100%' } as CSSProperties}
		>
			<div className="sg-workspace-body flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				{!expanded && !compact && !slim && slide === 'still' ? (
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
				<div className={cn('min-h-0 min-w-0 flex-1 flex-col', viewing ? 'hidden' : 'flex')}>{children}</div>
				<OutputViewerDock active={viewing} />
			</div>
		</section>
	);
}
