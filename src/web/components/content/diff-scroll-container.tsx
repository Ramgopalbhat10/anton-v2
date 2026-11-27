import { Virtualizer } from '@pierre/diffs/react';
import type { ReactNode } from 'react';

/**
 * Scroll container wired to `@pierre/diffs`'s `<Virtualizer>` when browser observers exist,
 * falling back to a plain scrolling `<div>` in test DOM environments.
 */
export function DiffScrollContainer({ children, className }: { children: ReactNode; className?: string }) {
	if (typeof window !== 'undefined' && typeof IntersectionObserver !== 'undefined' && typeof ResizeObserver !== 'undefined' && !('happyDOM' in window)) {
		return <Virtualizer className={className}>{children}</Virtualizer>;
	}
	return <div className={className}>{children}</div>;
}
