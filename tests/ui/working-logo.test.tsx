import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkingLogo } from '@/components/marks/working-logo';

function motionPreference(initial = false) {
	let reduced = initial;
	const events = new EventTarget();
	vi.stubGlobal('matchMedia', () => ({
		get matches() { return reduced; },
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
	}));
	return (next: boolean) => act(() => { reduced = next; events.dispatchEvent(new Event('change')); });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('WorkingLogo', () => {
	it.each([['spin', 0.2], ['roll', 0.9]] as const)('restores the historical %s, ignores face animation ends, and cleans up on finish', (turn, random) => {
		vi.useFakeTimers();
		motionPreference();
		vi.spyOn(Math, 'random').mockReturnValue(random);
		const view = render(<WorkingLogo active />);
		act(() => vi.advanceTimersByTime(4500));
		const mark = screen.getByRole('status', { name: 'Anton is working' });
		expect(mark.classList.contains(`is-${turn}`)).toBe(true);
		fireEvent.animationEnd(mark.querySelector('.aw-face')!);
		expect(mark.classList.contains(`is-${turn}`)).toBe(true);
		fireEvent.animationEnd(mark.querySelector('.aw-cube')!);
		expect(mark.className).not.toContain('is-');
		expect(vi.getTimerCount()).toBe(1);
		view.rerender(<WorkingLogo active={false} />);
		expect(screen.queryByRole('status')).toBeNull();
		expect(view.container.querySelector('.anton-logo')).toBeTruthy();
		expect(vi.getTimerCount()).toBe(0);
		view.rerender(<WorkingLogo active />);
		expect(vi.getTimerCount()).toBe(1);
		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps the working status without scheduling motion, including live preference changes mid-roll', () => {
		vi.useFakeTimers();
		const reduce = motionPreference(true);
		vi.spyOn(Math, 'random').mockReturnValue(0.9);
		const view = render(<WorkingLogo active />);
		expect(screen.getByRole('status', { name: 'Anton is working' })).toBeTruthy();
		expect(vi.getTimerCount()).toBe(0);
		reduce(false);
		act(() => vi.advanceTimersByTime(4500));
		expect(view.container.querySelector('.is-roll')).toBeTruthy();
		reduce(true);
		expect(view.container.querySelector('.is-roll')).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		reduce(false);
		expect(vi.getTimerCount()).toBe(1);
		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
