import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { JumpToLatest } from '@/components/jump-to-latest';
import { useFollowLatest } from '@/lib/use-follow-latest';

function Feed() {
	const ref = useRef<HTMLDivElement>(null);
	const { following, follow, release } = useFollowLatest(ref);
	return (
		<div ref={ref} data-testid="scroller" style={{ overflowY: 'auto' }}>
			<div>reply</div>
			<button onClick={release}>Navigate</button>
			<JumpToLatest show={!following} live onJump={follow} />
		</div>
	);
}

/** A view 500px tall over 2000px of content; there is no layout here. */
function sized(el: HTMLElement) {
	Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 2000 });
	Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 500 });
	return el;
}

function scrollTo(el: HTMLElement, top: number) {
	act(() => {
		el.scrollTop = top;
		fireEvent.scroll(el);
	});
}

describe('useFollowLatest', () => {
	it('lets go when you scroll up, and picks up again at the bottom or from the button', () => {
		render(<Feed />);
		const scroller = sized(screen.getByTestId('scroller'));
		scrollTo(scroller, 1500);
		expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

		scrollTo(scroller, 900);
		expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeTruthy();

		scrollTo(scroller, 1500);
		expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

		scrollTo(scroller, 400);
		fireEvent.click(screen.getByRole('button', { name: /Jump to latest/ }));
		expect(scroller.scrollTop).toBe(2000);
		expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
	});

	it('lets go on a wheel up before the scroll lands', () => {
		render(<Feed />);
		const scroller = sized(screen.getByTestId('scroller'));
		scrollTo(scroller, 1500);
		act(() => {
			fireEvent.wheel(scroller, { deltaY: -100 });
		});
		expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeTruthy();
	});
	it('holds follow off through smooth scroll events near the bottom and a resize', () => {
		vi.useFakeTimers();
		let resize = () => {};
		vi.stubGlobal('ResizeObserver', class {
			constructor(callback: () => void) { resize = callback; }
			observe() {}
			disconnect() {}
		});
		try {
			render(<Feed />);
			const scroller = sized(screen.getByTestId('scroller'));
			scrollTo(scroller, 1500);
			fireEvent.click(screen.getByRole('button', { name: 'Navigate' }));
			scrollTo(scroller, 1495); // Still within the 32px bottom slack.
			act(() => resize()); // A streamed reply or another child grew.
			expect(scroller.scrollTop).toBe(1495);
			expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeTruthy();
			scrollTo(scroller, 900);
			fireEvent(scroller, new Event('scrollend'));
			scrollTo(scroller, 1500);
			expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
		} finally {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it('recovers following if a navigation never moves', () => {
		vi.useFakeTimers();
		try {
			render(<Feed />);
			const scroller = sized(screen.getByTestId('scroller'));
			scrollTo(scroller, 1500);
			fireEvent.click(screen.getByRole('button', { name: 'Navigate' }));
			act(() => vi.advanceTimersByTime(200));
			expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
		} finally { vi.useRealTimers(); }
	});

});
