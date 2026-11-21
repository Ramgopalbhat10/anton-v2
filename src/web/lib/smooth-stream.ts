import { useEffect, useRef, useState } from 'react';

/** Target time (ms) for the catch-up cursor to absorb an incoming burst. */
const CATCH_UP_MS = 120;
/** Minimum characters revealed per second so short tails finish crisply. */
const MIN_CHARS_PER_SEC = 80;
/** Cap per-frame delta so returning from a backgrounded tab advances cleanly. */
const MAX_DT_MS = 50;

/** Advances `end` by 1 if slicing there would split a UTF-16 surrogate pair (e.g. an emoji). */
export function safeSliceEnd(text: string, end: number): number {
	if (end <= 0) return 0;
	if (end >= text.length) return text.length;
	const code = text.charCodeAt(end - 1);
	return code >= 0xd800 && code <= 0xdbff ? Math.min(end + 1, text.length) : end;
}

function reducedMotion(): boolean {
	return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Smoothly paces newly arrived text over animation frames while a block is streaming, so bursts from the
 * server or provider glide in instead of jumping in chunks. Non-streaming text, reduced motion, and text
 * already present on mount return immediately without replay.
 */
export function useSmoothText(text: string, streaming: boolean): string {
	const immediate = !streaming || reducedMotion();
	const [shown, setShown] = useState(() => ({ text, length: text.length }));
	const targetRef = useRef(text);
	const shownTextRef = useRef(text);
	const shownLengthRef = useRef(text.length);
	const frameRef = useRef<number | null>(null);
	const lastTimeRef = useRef(0);

	const isExtension = !immediate && text.startsWith(shown.text.slice(0, shown.length));
	const displayLength = immediate ? text.length : isExtension ? Math.min(shown.length, text.length) : text.length;

	useEffect(() => {
		targetRef.current = text;
		if (immediate) {
			if (frameRef.current !== null) {
				cancelAnimationFrame(frameRef.current);
				frameRef.current = null;
			}
			lastTimeRef.current = 0;
			shownTextRef.current = text;
			shownLengthRef.current = text.length;
			setShown((current) => (current.text === text && current.length === text.length ? current : { text, length: text.length }));
			return;
		}

		if (shownLengthRef.current > text.length || !text.startsWith(shownTextRef.current.slice(0, shownLengthRef.current))) {
			if (frameRef.current !== null) {
				cancelAnimationFrame(frameRef.current);
				frameRef.current = null;
			}
			lastTimeRef.current = 0;
			shownTextRef.current = text;
			shownLengthRef.current = text.length;
			setShown({ text, length: text.length });
			return;
		}

		if (shownLengthRef.current >= text.length) return;
		if (frameRef.current !== null) return;

		lastTimeRef.current = 0;
		const tick = (now: number) => {
			const target = targetRef.current;
			const dt = lastTimeRef.current ? Math.min(MAX_DT_MS, Math.max(1, now - lastTimeRef.current)) : 16;
			lastTimeRef.current = now;
			const remaining = target.length - shownLengthRef.current;
			if (remaining <= 0) {
				frameRef.current = null;
				lastTimeRef.current = 0;
				return;
			}
			const minStep = Math.ceil((MIN_CHARS_PER_SEC * dt) / 1000);
			const proportionalStep = Math.ceil((remaining * dt) / CATCH_UP_MS);
			const nextLength = safeSliceEnd(target, Math.min(target.length, shownLengthRef.current + Math.max(minStep, proportionalStep)));
			shownTextRef.current = target;
			shownLengthRef.current = nextLength;
			setShown({ text: target, length: nextLength });
			if (nextLength < target.length) {
				frameRef.current = requestAnimationFrame(tick);
			} else {
				frameRef.current = null;
				lastTimeRef.current = 0;
			}
		};
		frameRef.current = requestAnimationFrame(tick);
	}, [text, immediate]);

	useEffect(() => {
		return () => {
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
		};
	}, []);

	return displayLength >= text.length ? text : text.slice(0, displayLength);
}
