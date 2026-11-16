import { useEffect, useRef, useState } from 'react';

/*
 * Every `title` in the app as the same dark tip: no arrow, Inter, on the
 * app's own black, instead of the browser's yellow box. One listener on the
 * document takes an element's title into `data-tip` the first time the
 * pointer or focus reaches it (so the browser never draws its own), keeps it
 * as the element's accessible name when it has no other, and shows the tip
 * above it (below when there is no room). Radix tooltips share the look
 * through `.tip` in styles.css.
 */

const DELAY = 450;
/** Moving from one tip to the next within this long shows the next at once. */
const WARM = 600;
const GAP = 6;

type Tip = { text: string; x: number; y: number; below: boolean };

function owner(target: EventTarget | null): HTMLElement | null {
	if (!(target instanceof Element)) return null;
	const element = target.closest<HTMLElement>('[title], [data-tip]');
	if (!element || element instanceof HTMLIFrameElement) return null;
	const title = element.getAttribute('title');
	if (title !== null) {
		element.removeAttribute('title');
		if (title.trim()) {
			element.setAttribute('data-tip', title);
			// The title was the name a screen reader used when nothing else names it.
			if (!element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby') && !element.textContent?.trim()) element.setAttribute('aria-label', title);
		} else element.removeAttribute('data-tip');
	}
	return element.getAttribute('data-tip') ? element : null;
}

function place(element: HTMLElement): Tip {
	const box = element.getBoundingClientRect();
	const below = box.top < 40;
	return { text: element.getAttribute('data-tip') ?? '', x: box.left + box.width / 2, y: below ? box.bottom + GAP : box.top - GAP, below };
}

export function TitleTips() {
	const [tip, setTip] = useState<Tip | null>(null);
	const [shift, setShift] = useState(0);
	const ref = useRef<HTMLDivElement>(null);
	const current = useRef<HTMLElement | null>(null);
	const timer = useRef<number | undefined>(undefined);
	const lastHidden = useRef(0);

	useEffect(() => {
		const hide = () => {
			window.clearTimeout(timer.current);
			if (current.current) lastHidden.current = Date.now();
			current.current = null;
			setTip(null);
		};
		const show = (element: HTMLElement) => {
			if (current.current === element) return;
			window.clearTimeout(timer.current);
			current.current = element;
			const warm = Date.now() - lastHidden.current < WARM;
			const open = () => {
				if (current.current === element && element.isConnected) setTip(place(element));
			};
			if (warm) open();
			else {
				setTip(null);
				timer.current = window.setTimeout(open, DELAY);
			}
		};
		const over = (event: PointerEvent) => {
			if (event.pointerType === 'touch') return;
			const element = owner(event.target);
			if (element) show(element);
			else if (current.current) hide();
		};
		const focus = (event: FocusEvent) => {
			const element = owner(event.target);
			if (element && (event.target as Element).matches(':focus-visible')) show(element);
		};
		const leave = (event: PointerEvent | FocusEvent) => {
			const next = (event as PointerEvent).relatedTarget as Node | null;
			if (current.current && next && current.current.contains(next)) return;
			if (current.current) hide();
		};
		document.addEventListener('pointerover', over, true);
		document.addEventListener('pointerout', leave, true);
		document.addEventListener('focusin', focus, true);
		document.addEventListener('focusout', leave, true);
		document.addEventListener('pointerdown', hide, true);
		document.addEventListener('keydown', hide, true);
		window.addEventListener('scroll', hide, true);
		window.addEventListener('blur', hide);
		return () => {
			window.clearTimeout(timer.current);
			document.removeEventListener('pointerover', over, true);
			document.removeEventListener('pointerout', leave, true);
			document.removeEventListener('focusin', focus, true);
			document.removeEventListener('focusout', leave, true);
			document.removeEventListener('pointerdown', hide, true);
			document.removeEventListener('keydown', hide, true);
			window.removeEventListener('scroll', hide, true);
			window.removeEventListener('blur', hide);
		};
	}, []);

	// Kept inside the window: nudged back from either edge once its width is known.
	useEffect(() => {
		const element = ref.current;
		if (!tip || !element) return;
		const width = element.offsetWidth;
		const left = tip.x - width / 2;
		const room = window.innerWidth - 8;
		setShift(left < 8 ? 8 - left : left + width > room ? room - (left + width) : 0);
	}, [tip]);

	if (!tip) return null;
	return (
		<div
			ref={ref}
			role="tooltip"
			className="tip pointer-events-none fixed z-[100]"
			style={{ left: tip.x + shift, top: tip.y, transform: `translate(-50%, ${tip.below ? '0' : '-100%'})` }}
		>
			{tip.text}
		</div>
	);
}
