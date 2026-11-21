import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Btn, Spinner } from '@/components/kit/signal';
import type { OlderTurns } from '@/lib/conversation-window';

/** How far above the view the start of what is shown can be before the next older page is read. */
const READ_AHEAD_PX = 600;

/**
 * Sits before a conversation's first row. Scrolling up near it reads the older turns, and they go in above without
 * moving what you are reading. While the view follows the latest message it reads nothing on its own, unless the
 * conversation is too short to scroll; the button reads the next page either way.
 */
export function OlderTurnsRow({ older, scroller, following, first }: { older?: OlderTurns; scroller: RefObject<HTMLElement | null>; following: boolean; first: string | null }) {
	const sentinel = useRef<HTMLDivElement>(null);
	useKeepPlace(scroller, sentinel, first);
	const more = Boolean(older?.more);
	const load = older?.load;
	// Only once rows are drawn: a view that draws the conversation a moment later is not one too short to scroll.
	const idle = more && !older?.loading && !older?.failed && first !== null;

	const near = useCallback(() => {
		const el = scroller.current;
		const mark = sentinel.current;
		if (!el || !mark) return false;
		if (following && el.scrollHeight > el.clientHeight) return false;
		return mark.getBoundingClientRect().bottom >= el.getBoundingClientRect().top - READ_AHEAD_PX;
	}, [scroller, following]);

	// Scrolling up to within reach of the start; and again once a page lands while the start is still in reach.
	useEffect(() => {
		const el = scroller.current;
		const mark = sentinel.current;
		if (!idle || !load || !el || !mark) return;
		if (near()) {
			load();
			return;
		}
		if (typeof IntersectionObserver === 'undefined') return;
		const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && near() && load(), { root: el, rootMargin: `${READ_AHEAD_PX}px 0px 0px 0px` });
		observer.observe(mark);
		return () => observer.disconnect();
	}, [idle, load, near, scroller]);

	if (!older || (!more && !older.loading)) return <div ref={sentinel} aria-hidden className="h-0" />;
	return (
		<div ref={sentinel} className="flex min-h-7 items-center justify-center text-small text-(--text-3)">
			{older.loading ? (
				<span className="flex items-center gap-2" role="status">
					<Spinner size={12} tone="neutral" />
					Loading earlier messages
				</span>
			) : older.failed ? (
				<span className="flex items-center gap-2">
					Earlier messages did not load.
					<Btn size="sm" variant="ghost" onClick={older.load}>
						Try again
					</Btn>
				</span>
			) : (
				<Btn size="sm" variant="ghost" onClick={older.load}>
					Show earlier messages
				</Btn>
			)}
		</div>
	);
}

/**
 * Keeps the row after `mark` where it was on screen when rows go in before it: its place is read before React changes
 * the page (the render, while the page still shows the old rows) and put back right after, before it is painted.
 */
function useKeepPlace(scroller: RefObject<HTMLElement | null>, mark: RefObject<HTMLElement | null>, first: string | null) {
	const seen = useRef(first);
	const held = useRef<{ row: Element; top: number } | null>(null);
	if (seen.current !== first) {
		seen.current = first;
		const row = mark.current?.nextElementSibling;
		held.current = row ? { row, top: row.getBoundingClientRect().top } : null;
	}
	useLayoutEffect(() => {
		const hold = held.current;
		held.current = null;
		const el = scroller.current;
		if (!hold || !el || !hold.row.isConnected) return;
		const moved = hold.row.getBoundingClientRect().top - hold.top;
		if (Math.abs(moved) >= 1) el.scrollTop += moved;
	}, [first, scroller]);
}
