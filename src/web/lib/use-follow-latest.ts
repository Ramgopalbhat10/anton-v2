import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/** Closer to the bottom than this counts as at it: a line of slack for rounding and a nudge of the wheel. */
const SLACK = 32;

/** The element that scrolls `el`: `el` itself when it scrolls, else its nearest ancestor that does. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
	for (let node: HTMLElement | null = el; node; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY;
		if (overflow === 'auto' || overflow === 'scroll') return node;
	}
	return null;
}

function atBottom(el: HTMLElement) {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK;
}

/**
 * Keeps a scrolling view at its newest content while it grows, as a reply
 * streams, but only while the reader is already at the bottom. Scrolling up
 * lets go, so what they are reading stays put; scrolling back down, or
 * `follow()` (a message sent, the "Jump to latest" button), picks it up again.
 *
 * `ref` is the scroller, or any element inside it. `enabled: false` never
 * moves the view. A change of `reset` (another conversation) follows anew.
 */
export function useFollowLatest(ref: RefObject<HTMLElement | null>, { enabled = true, reset }: { enabled?: boolean; reset?: unknown } = {}) {
	const [following, setFollowing] = useState(true);
	const pinned = useRef(true);
	const scroller = useRef<HTMLElement | null>(null);
	const pin = useCallback((on: boolean) => {
		pinned.current = on;
		setFollowing(on);
	}, []);

	const follow = useCallback(() => {
		pin(true);
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [pin]);

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
			// Growth below never moves scrollTop, so only the reader's own scroll up lets go.
			if (atBottom(el)) {
				if (!pinned.current) pin(true);
			} else if (top < last && pinned.current) pin(false);
			last = top;
		};
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY < 0 && pinned.current && el.scrollHeight > el.clientHeight) pin(false);
		};
		const onTouchStart = () => {
			touching = true;
		};
		const onTouchEnd = () => {
			touching = false;
			if (atBottom(el)) pin(true);
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		el.addEventListener('wheel', onWheel, { passive: true });
		el.addEventListener('touchstart', onTouchStart, { passive: true });
		el.addEventListener('touchend', onTouchEnd, { passive: true });
		el.addEventListener('touchcancel', onTouchEnd, { passive: true });
		// The view and what is in it, resized: new text, a card opening, an image loading, the composer or the keyboard taking room.
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(stick);
		observer?.observe(el);
		for (const child of el.children) observer?.observe(child);
		return () => {
			observer?.disconnect();
			el.removeEventListener('scroll', onScroll);
			el.removeEventListener('wheel', onWheel);
			el.removeEventListener('touchstart', onTouchStart);
			el.removeEventListener('touchend', onTouchEnd);
			el.removeEventListener('touchcancel', onTouchEnd);
		};
	}, [ref, enabled, reset, pin]);

	const release = useCallback(() => pin(false), [pin]);

	return { following: following || !enabled, follow, release };
}
