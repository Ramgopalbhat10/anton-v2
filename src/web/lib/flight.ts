/** A composer that changes dock plays a FLIP from its old box; only the painted transform moves, never the layout box. */
function still(): boolean {
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function flyFrom(el: Element, from: DOMRect, duration = 460) {
	if (still()) return;
	const to = el.getBoundingClientRect();
	const dx = from.left - to.left;
	const dy = from.top - to.top;
	const sx = from.width / to.width;
	const sy = from.height / to.height;
	if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return;
	el.animate(
		[
			{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: '0 0' },
			{ transform: 'translate(0px, 0px) scale(1, 1)', transformOrigin: '0 0' },
		],
		{ duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
	);
}
