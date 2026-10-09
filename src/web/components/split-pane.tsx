import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** A number kept in this browser, such as a panel's width; it works without storage too. */
export function useStoredState<T>(key: string, fallback: T): [T, (next: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const saved = localStorage.getItem(key);
			return saved === null ? fallback : (JSON.parse(saved) as T);
		} catch {
			return fallback;
		}
	});
	return [
		value,
		(next: T) => {
			setValue(next);
			try {
				localStorage.setItem(key, JSON.stringify(next));
			} catch {
				// Remembering is a convenience; the panel works without it.
			}
		},
	];
}

/**
 * The thin line between two panels that resizes the one before it: drag it,
 * use the arrow keys, or double-click it to go back to the default width.
 */
export function ResizeHandle({
	label,
	width,
	min,
	max,
	initial,
	onResize,
	className,
}: {
	label: string;
	width: number;
	min: number;
	max: number;
	/** What a double-click goes back to. */
	initial: number;
	onResize: (width: number) => void;
	className?: string;
}) {
	const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
	const [dragging, setDragging] = useState(false);
	const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)));
	return (
		<div
			role="separator"
			aria-label={label}
			aria-orientation="vertical"
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={width}
			tabIndex={0}
			data-dragging={dragging || undefined}
			// The default as asked for, not squeezed to today's room, so it holds when there is more space again.
			onDoubleClick={() => onResize(initial)}
			onKeyDown={(event) => {
				const next = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: min, End: max }[event.key];
				if (next === undefined) return;
				event.preventDefault();
				onResize(clamp(next));
			}}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.focus();
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { pointer: event.pointerId, x: event.clientX, width };
				setDragging(true);
			}}
			onPointerMove={(event) => {
				const start = drag.current;
				if (start?.pointer === event.pointerId) onResize(clamp(start.width + event.clientX - start.x));
			}}
			onPointerUp={(event) => {
				if (drag.current?.pointer !== event.pointerId) return;
				event.currentTarget.releasePointerCapture(event.pointerId);
				drag.current = null;
				setDragging(false);
			}}
			onLostPointerCapture={() => {
				drag.current = null;
				setDragging(false);
			}}
			className={cn(
				'group/handle relative flex w-2.5 shrink-0 cursor-col-resize touch-none justify-center outline-none',
				// A hairline that lights on hover, focus and drag.
				'before:h-full before:w-px before:rounded-full before:bg-(--border-subtle) before:transition-colors before:duration-(--duration-micro) hover:before:bg-(--accent-border) focus-visible:before:bg-(--accent-base) data-dragging:before:bg-(--accent-base)',
				className,
			)}
		/>
	);
}
