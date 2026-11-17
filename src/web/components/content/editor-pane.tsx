import { FileDiff, Files, GitBranch, PanelLeftOpen, X } from '@/lib/icons';
import type { IconComponent } from '@/lib/icons';
import { type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ResizeHandle, useStoredState } from '@/components/kit/split-pane';
import { Icon, IconBtn } from '@/components/kit/signal';
import { cn } from '@/lib/utils';
import { setChangesScope, ShowPanel } from '@/lib/workspace';

const SIDE_DEFAULT = 220;
const SIDE_MIN = 140;
const MAIN_MIN = 200;
/** Below this the side and main columns take turns at full width, as on a phone, rather than squeezing side by side. */
const SIDE_BY_SIDE_MIN = 520;

export type ExplorerMode = 'files' | 'changes' | 'branch';

const MODES: Array<{ mode: ExplorerMode; icon: IconComponent; label: string }> = [
	{ mode: 'files', icon: Files, label: 'Files' },
	{ mode: 'changes', icon: FileDiff, label: 'Changes not pushed' },
	{ mode: 'branch', icon: GitBranch, label: 'Whole branch' },
];

function ModeSwitch({ sessionId, mode }: { sessionId: string; mode: ExplorerMode }) {
	const showPanel = useContext(ShowPanel);
	return (
		<div role="group" aria-label="Explorer" className="flex items-center gap-0.5">
			{MODES.map((item) => (
				<button
					type="button"
					key={item.mode}
					aria-label={item.label}
					title={item.label}
					aria-pressed={mode === item.mode}
					onClick={() => {
						if (item.mode === mode) return;
						if (item.mode === 'files') return showPanel('Files');
						setChangesScope(sessionId, item.mode === 'branch' ? 'branch' : 'unpushed');
						if (mode === 'files') showPanel('Changes');
					}}
					className={cn(
						'inline-flex size-6 items-center justify-center rounded-control outline-none transition-colors duration-(--t-fast) focus-visible:shadow-(--focus)',
						mode === item.mode
							? 'in-chosen'
							: 'text-(--text-3) hover:bg-(--bg-hover) hover:text-(--text-2)',
					)}
				>
					<Icon icon={item.icon} size={13} />
				</button>
			))}
		</div>
	);
}

/** Files and Changes share this frame: an explorer and what you opened from it, taking turns on a narrow pane. `main` gets the button back to the explorer; null while the explorer shows beside it. */
export function EditorPane({
	name,
	sessionId,
	mode,
	side,
	sideLabel,
	opened,
	main,
}: {
	/** Where the side column's width and whether it is put away are remembered, per kind of pane. */
	name: 'files' | 'changes';
	sessionId: string;
	mode: ExplorerMode;
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
	const sideToggle = showSide ? null : (
		<IconBtn
			icon={PanelLeftOpen}
			size="xs"
			label="Show the file tree"
			aria-pressed={false}
			onClick={() => (narrow ? setSideTurn(true) : setSideHidden(false))}
			className="shrink-0"
		/>
	);

	return (
		<div ref={row} className="flex min-h-0 flex-1 overflow-hidden rounded-card bg-(--bg-surface)">
			<div
				aria-label={sideLabel}
				hidden={!showSide}
				className={cn('min-h-0 shrink-0 flex-col', showSide ? 'flex' : 'hidden', narrow && 'flex-1')}
				style={narrow ? undefined : { width }}
			>
				<div className="flex h-9 shrink-0 items-center gap-1 border-b border-(--line) px-1.5">
					<ModeSwitch sessionId={sessionId} mode={mode} />
					<span className="flex-1" />
					{/* Nothing is open beside it on a narrow pane, so there is nothing to put it away for. */}
					{narrow ? null : <IconBtn icon={X} size="xs" label="Hide the file tree" aria-pressed onClick={() => setSideHidden(true)} />}
				</div>
				<div className="flex min-h-0 flex-1 flex-col overflow-auto p-1.5">{side}</div>
			</div>
			{showSide && !narrow ? (
				<ResizeHandle label={`Resize the ${sideLabel.toLowerCase()}`} width={width} min={SIDE_MIN} max={sideMax} initial={SIDE_DEFAULT} onResize={setSideWidth} className="z-[2] -mx-[5px]" />
			) : null}
			<div className={cn('min-h-0 min-w-0 flex-1 flex-col overflow-hidden', showMain ? 'flex' : 'hidden')}>{main(sideToggle)}</div>
		</div>
	);
}

export function EditorBar({ sideToggle, children, className }: { sideToggle: ReactNode; children: ReactNode; className?: string }) {
	return (
		<div className={cn('flex h-9 shrink-0 items-center gap-1.5 border-b border-(--line) px-1.5', className)}>
			{sideToggle ? (
				<>
					{sideToggle}
					<span aria-hidden className="h-4 w-px shrink-0 bg-(--line)" />
				</>
			) : null}
			{children}
		</div>
	);
}
