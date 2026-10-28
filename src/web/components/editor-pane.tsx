import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ResizeHandle, useStoredState } from '@/components/split-pane';
import { IconBtn } from '@/components/signal';
import { cn } from '@/lib/utils';

/** The side column's width: remembered, and kept between these bounds; the main column beside it takes the rest. */
const SIDE_DEFAULT = 220;
const SIDE_MIN = 140;
/** The main column keeps at least this much room. */
const MAIN_MIN = 200;
/** Below this the side and main columns take turns at full width, as on a phone, rather than squeezing side by side. */
const SIDE_BY_SIDE_MIN = 520;

/**
 * The editor layout Files and Changes share: a file tree on the left, which
 * you can resize or put away, and what you opened from it on the right. On a
 * narrow pane the two take turns: the tree until something is open, then the
 * open thing with a button back to the tree.
 *
 * `main` is given that button, for the bar at its top.
 */
export function EditorPane({
	name,
	side,
	sideLabel,
	opened,
	main,
}: {
	/** Where the side column's width and whether it is put away are remembered, per kind of pane. */
	name: 'files' | 'changes';
	side: ReactNode;
	sideLabel: string;
	/** What is open in the main column, by its path; null shows the side column alone on a narrow pane. Opening something hands the main column its turn. */
	opened: string | null;
	main: (sideToggle: ReactNode) => ReactNode;
}) {
	const [sideWidth, setSideWidth] = useStoredState(`anton.${name}.tree-width`, SIDE_DEFAULT);
	const [sideHidden, setSideHidden] = useStoredState(`anton.${name}.tree-hidden`, false);
	const [sideTurn, setSideTurn] = useState(false);
	useEffect(() => setSideTurn(false), [opened]);
	const row = useRef<HTMLDivElement>(null);
	const [rowWidth, setRowWidth] = useState(0);
	useLayoutEffect(() => {
		const element = row.current;
		if (!element) return;
		const measure = () => setRowWidth(Math.round(element.getBoundingClientRect().width));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const sideMax = Math.max(SIDE_MIN, (rowWidth || 800) - MAIN_MIN);
	const width = Math.min(sideMax, Math.max(SIDE_MIN, sideWidth));
	const narrow = rowWidth > 0 && rowWidth < SIDE_BY_SIDE_MIN;
	const showSide = narrow ? !opened || sideTurn : !opened || !sideHidden;
	const showMain = !narrow || !showSide;
	const away = narrow || sideHidden;
	const sideToggle = (
		<IconBtn
			icon={away ? PanelLeftOpen : PanelLeftClose}
			size="xs"
			label={away ? 'Show the file tree' : 'Hide the file tree'}
			aria-pressed={!away}
			onClick={() => (narrow ? setSideTurn(true) : setSideHidden(!sideHidden))}
			className="shrink-0"
		/>
	);

	return (
		<div ref={row} className="flex min-h-0 flex-1">
			<div
				aria-label={sideLabel}
				hidden={!showSide}
				className={cn('min-h-0 shrink-0 flex-col overflow-auto', showSide ? 'flex' : 'hidden', narrow && 'flex-1')}
				style={narrow ? undefined : { width }}
			>
				{side}
			</div>
			{showSide && !narrow ? (
				<ResizeHandle label={`Resize the ${sideLabel.toLowerCase()}`} width={width} min={SIDE_MIN} max={sideMax} initial={SIDE_DEFAULT} onResize={setSideWidth} className="mx-0.5" />
			) : null}
			<div className={cn('in-well min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--bg-inset)', showMain ? 'flex' : 'hidden')}>{main(sideToggle)}</div>
		</div>
	);
}

/** The bar along the top of the main column: the tree's toggle, a divider, then what the pane puts there. */
export function EditorBar({ sideToggle, children, className }: { sideToggle: ReactNode; children: ReactNode; className?: string }) {
	return (
		<div className={cn('flex shrink-0 items-center gap-1 border-b border-(--border-subtle) bg-[linear-gradient(180deg,var(--card-bg-top),var(--card-bg))] p-1', className)}>
			{sideToggle}
			<span aria-hidden className="h-4 w-px shrink-0 bg-(--border-subtle)" />
			{children}
		</div>
	);
}
