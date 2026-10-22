import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useState } from 'react';

/** How long opening out or folding back takes. */
const EASE_MS = 220;

/**
 * Text that keeps to a few lines until it is opened out to its whole height
 * (`cap`, a share of the window, stops it growing, and it scrolls), and folds
 * back. Heights come from the box's own line height and padding, so it fits
 * wherever it is used. The height eases only on a toggle, so typing never waits on it.
 * `content` is what the box shows, to measure again when it changes.
 */
export function useFold(box: () => HTMLElement | null, content: unknown, { lines, cap }: { lines: number; cap?: number }) {
	const [open, setOpen] = useState(false);
	const [heights, setHeights] = useState<{ folded: number; whole: number; long: boolean } | null>(null);
	const [easing, setEasing] = useState(false);
	const measure = useCallback(() => {
		const element = box();
		if (!element) return;
		const style = getComputedStyle(element);
		const px = (value: string) => Number.parseFloat(value) || 0;
		const folded = Math.round((px(style.lineHeight) || 22) * lines + px(style.paddingTop) + px(style.paddingBottom));
		const whole = cap ? Math.min(element.scrollHeight, Math.round(window.innerHeight * cap)) : element.scrollHeight;
		const long = element.scrollHeight > folded + 1;
		setHeights((current) => (current?.folded === folded && current.whole === whole && current.long === long ? current : { folded, whole, long }));
	}, [box, lines, cap]);
	useLayoutEffect(measure, [measure, content, open]);
	useEffect(() => {
		const element = box();
		if (!element) return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		window.addEventListener('resize', measure);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', measure);
		};
	}, [box, measure]);
	useEffect(() => {
		if (!easing) return;
		const timer = setTimeout(() => setEasing(false), EASE_MS);
		return () => clearTimeout(timer);
	}, [easing]);
	const long = heights?.long ?? false;
	// Text that fits again (sent, or cut back) folds, so the next long one starts folded.
	useEffect(() => {
		if (!long) setOpen(false);
	}, [long]);
	const style: CSSProperties | undefined = heights
		? { maxHeight: open ? heights.whole : heights.folded, transition: easing ? `max-height ${EASE_MS}ms ease-in` : undefined }
		: undefined;
	return {
		long,
		open,
		style,
		toggle: () => {
			setEasing(true);
			setOpen((current) => !current);
		},
	};
}
