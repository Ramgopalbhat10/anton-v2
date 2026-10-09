import { useLayoutEffect, useState } from 'react';

/**
 * An element's size, kept current as it changes. Give the returned callback to
 * the element's `ref`; it works for an element that mounts later, too.
 */
export function useElementSize<T extends HTMLElement>() {
	const [element, setElement] = useState<T | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	useLayoutEffect(() => {
		if (!element) return;
		const measure = () => {
			const box = element.getBoundingClientRect();
			setSize({ width: Math.round(box.width), height: Math.round(box.height) });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return [setElement, size] as const;
}
