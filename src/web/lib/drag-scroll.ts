import { useCallback, useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

/** Drag and vertical-wheel scrolling for a sideways row, with no click left behind after a drag. Tracked on the window, not by pointer capture, so a plain click still lands where it started. */
export function useDragScroll() {
	const moved = useRef(false);
	const drag = useRef(0);
	const ref = useCallback((el: HTMLElement | null) => {
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			// A mostly-horizontal wheel already scrolls the row on its own.
			if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
			const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1;
			const next = Math.max(0, Math.min(el.scrollLeft + event.deltaY * unit, el.scrollWidth - el.clientWidth));
			if (next === el.scrollLeft) return;
			event.preventDefault();
			el.scrollLeft = next;
		};
		// Non-passive, so the wheel can be kept from scrolling the page too.
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}, []);
	return {
		ref,
		onPointerDown: (event: PointerEvent<HTMLElement>) => {
			if (event.button !== 0 || event.pointerType === 'touch') return;
			const el = event.currentTarget;
			const start = { id: event.pointerId, x: event.clientX, left: el.scrollLeft, token: ++drag.current };
			moved.current = false;
			const move = (next: globalThis.PointerEvent) => {
				if (next.pointerId !== start.id || start.token !== drag.current) return;
				const dx = next.clientX - start.x;
				if (!moved.current && Math.abs(dx) < 4) return;
				moved.current = true;
				el.style.userSelect = 'none';
				el.scrollLeft = start.left - dx;
			};
			const finish = (next: globalThis.PointerEvent) => {
				if (next.pointerId !== start.id) return;
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', finish);
				window.removeEventListener('pointercancel', finish);
				el.style.userSelect = '';
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', finish);
			window.addEventListener('pointercancel', finish);
		},
		onClickCapture: (event: MouseEvent<HTMLElement>) => {
			// detail 0 is a keyboard click: it never follows a drag, so it always passes.
			if (event.detail === 0 || !moved.current) return;
			moved.current = false;
			event.preventDefault();
			event.stopPropagation();
		},
	};
}
