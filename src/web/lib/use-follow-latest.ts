import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/** Closer to the bottom than this counts as at it: a line of slack for rounding and a nudge of the wheel. */
export const FOLLOW_SLACK = 32;

function scrollerOf(el: HTMLElement): HTMLElement | null {
	for (let node: HTMLElement | null = el; node; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY;
		if (overflow === 'auto' || overflow === 'scroll') return node;
	}
	return null;
}

function atBottom(el: HTMLElement) {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
}

/**
 * Keeps a scroller at its newest content while it grows, only while the reader is at the bottom; scrolling up lets go,
 * scrolling down or `follow()` picks it up. `ref` is the scroller or an element in it; a change of `reset` follows anew.
 */
export function useFollowLatest(ref: RefObject<HTMLElement | null>, { enabled = true, reset }: { enabled?: boolean; reset?: unknown } = {}) {
	const [following, setFollowing] = useState(true);
	const pinned = useRef(true);
	const scroller = useRef<HTMLElement | null>(null);
	const navigating = useRef(false);
	const navigationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pin = useCallback((on: boolean) => {
		pinned.current = on;
		setFollowing(on);
	}, []);

	const cancelNavigation = useCallback(() => {
		navigating.current = false;
		if (navigationTimer.current !== null) clearTimeout(navigationTimer.current);
		navigationTimer.current = null;
	}, []);

	const finishNavigation = useCallback(() => {
		if (!navigating.current) return;
		cancelNavigation();
		if (scroller.current && atBottom(scroller.current)) pin(true);
	}, [cancelNavigation, pin]);

	// scrollend is not available everywhere, and an interrupted/no-op animation
	// may never emit it. Finish after scrolling has been quiet as a fallback.
	const waitForNavigation = useCallback(() => {
		if (navigationTimer.current !== null) clearTimeout(navigationTimer.current);
		navigationTimer.current = setTimeout(finishNavigation, 200);
	}, [finishNavigation]);

	const release = useCallback(() => {
		navigating.current = true;
		pin(false);
		waitForNavigation();
	}, [pin, waitForNavigation]);

	const follow = useCallback(() => {
		cancelNavigation();
		pin(true);
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [cancelNavigation, pin]);

	useEffect(() => {
		const target = ref.current;
		const el = target ? scrollerOf(target) : null;
		scroller.current = el;
		if (!el || !enabled) return;
		pin(true);
		el.scrollTop = el.scrollHeight;
		let last = el.scrollTop;
		// A finger on the screen holds the view still, so the page never moves under it.
		let touching = false;
		const stick = () => {
			if (pinned.current && !touching) el.scrollTop = el.scrollHeight;
			last = el.scrollTop;
		};
		const onScroll = () => {
			const top = el.scrollTop;
			// Smooth navigation starts within the bottom slack: do not repin while
			// its intermediate scroll events are arriving.
			if (navigating.current) {
				last = top;
				waitForNavigation();
				return;
			}
			// Growth below never moves scrollTop, so only the reader's own scroll up lets go.
			if (atBottom(el)) {
				if (!pinned.current) pin(true);
			} else if (top < last && pinned.current) pin(false);
			last = top;
		};
		const onWheel = (event: WheelEvent) => {
			cancelNavigation();
			if (event.deltaY < 0 && pinned.current && el.scrollHeight > el.clientHeight) pin(false);
		};
		const onTouchStart = () => {
			cancelNavigation();
			touching = true;
		};
		const onTouchEnd = () => {
			touching = false;
			if (atBottom(el)) pin(true);
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		el.addEventListener('scrollend', finishNavigation);
		el.addEventListener('wheel', onWheel, { passive: true });
		el.addEventListener('touchstart', onTouchStart, { passive: true });
		el.addEventListener('touchend', onTouchEnd, { passive: true });
		el.addEventListener('touchcancel', onTouchEnd, { passive: true });
		// The view and what is in it, resized: new text, a card opening, an image loading, the composer or the keyboard taking room.
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(stick);
		observer?.observe(el);
		for (const child of el.children) observer?.observe(child);
		return () => {
			// Let go of the view, so a cached closure over this hook never keeps a left page's DOM alive.
			scroller.current = null;
			observer?.disconnect();
			cancelNavigation();
			el.removeEventListener('scroll', onScroll);
			el.removeEventListener('scrollend', finishNavigation);
			el.removeEventListener('wheel', onWheel);
			el.removeEventListener('touchstart', onTouchStart);
			el.removeEventListener('touchend', onTouchEnd);
			el.removeEventListener('touchcancel', onTouchEnd);
		};
	}, [ref, enabled, reset, pin, cancelNavigation, finishNavigation, waitForNavigation]);

	return { following: following || !enabled, follow, release };
}
