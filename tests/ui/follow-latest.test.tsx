import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { JumpToLatest } from '@/components/jump-to-latest';
import { useFollowLatest } from '@/lib/use-follow-latest';

function Feed() {
	const ref = useRef<HTMLDivElement>(null);
	const { following, follow } = useFollowLatest(ref);
	return (
		<div ref={ref} data-testid="scroller" style={{ overflowY: 'auto' }}>
			<div>reply</div>
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
});
