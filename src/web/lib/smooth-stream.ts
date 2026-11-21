import { useEffect, useRef, useState } from 'react';

/** Target time (ms) for the catch-up cursor to absorb an incoming burst while streaming. */
const CATCH_UP_MS = 65;
/** Faster catch-up time (ms) to smoothly finish draining the trailing tail once streaming ends. */
const FINISH_CATCH_UP_MS = 45;
/** Minimum characters revealed per second so short tails finish crisply. */
const MIN_CHARS_PER_SEC = 80;
/** Minimum characters revealed per second when draining the final tail after streaming ends. */
const FINISH_MIN_CHARS_PER_SEC = 180;
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

export type IntervalForCursor = number | ((target: string, shownLength: number) => number);

/**
 * Smoothly paces newly arrived text over animation frames while a block is streaming, and smoothly drains
 * any remaining tail when streaming finishes so responses never jump at the end. When `minIntervalMs` (or
 * a cursor-aware callback) returns > 0 (e.g. while the reveal cursor is inside a large growing Markdown block
 * such as a long GFM table), emissions are throttled to at least that spacing so expensive reparses stay
 * within the frame budget. Non-streaming text, reduced motion, and text already present on mount return
 * immediately without replay.
 */
export function useSmoothText(text: string, streaming: boolean, minIntervalMs: IntervalForCursor = 0): string {
	const reduced = reducedMotion();
	const [shown, setShown] = useState(() => ({ text, length: text.length }));
	const targetRef = useRef(text);
	const streamingRef = useRef(streaming);
	const hadStreamingRef = useRef(streaming);
	const minIntervalRef = useRef<IntervalForCursor>(minIntervalMs);
	const shownTextRef = useRef(text);
	const shownLengthRef = useRef(text.length);
	const frameRef = useRef<number | null>(null);
	const lastTimeRef = useRef(0);

	if (streaming) hadStreamingRef.current = true;
	streamingRef.current = streaming;
	minIntervalRef.current = minIntervalMs;

	const pacing = !reduced && (streaming || (hadStreamingRef.current && shown.length < text.length));
	const isExtension = pacing && text.startsWith(shown.text.slice(0, shown.length));
	const displayLength = !pacing ? text.length : isExtension ? Math.min(shown.length, text.length) : text.length;

	useEffect(() => {
		targetRef.current = text;
		const shouldPace = !reduced && (streaming || (hadStreamingRef.current && shownLengthRef.current < text.length));
		if (!shouldPace) {
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
			const remaining = target.length - shownLengthRef.current;
			if (remaining <= 0) {
				frameRef.current = null;
				lastTimeRef.current = 0;
				return;
			}
			const intervalOption = minIntervalRef.current;
			const minInterval = typeof intervalOption === 'function' ? intervalOption(target, shownLengthRef.current) : intervalOption;
			if (minInterval > 0 && lastTimeRef.current > 0 && now - lastTimeRef.current < minInterval) {
				frameRef.current = requestAnimationFrame(tick);
				return;
			}
			const maxDt = Math.max(MAX_DT_MS, minInterval);
			const dt = lastTimeRef.current ? Math.min(maxDt, Math.max(1, now - lastTimeRef.current)) : 16;
			lastTimeRef.current = now;
			const finishing = !streamingRef.current;
			const catchUpMs = Math.max(finishing ? FINISH_CATCH_UP_MS : CATCH_UP_MS, minInterval * 1.5);
			const minRate = finishing ? FINISH_MIN_CHARS_PER_SEC : MIN_CHARS_PER_SEC;
			const minStep = Math.ceil((minRate * dt) / 1000);
			const proportionalStep = Math.ceil((remaining * dt) / catchUpMs);
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
	}, [text, streaming, reduced]);

	useEffect(() => {
		return () => {
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
		};
	}, []);

	return displayLength >= text.length ? text : text.slice(0, displayLength);
}
