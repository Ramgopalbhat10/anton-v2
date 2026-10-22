import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mascot, useMascotMood } from '@/components/mascot';

describe('The mascot on the composer', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('works while the agent runs, hops once when it stops, then rests', () => {
		const { result, rerender } = renderHook((props: { busy: boolean; waiting: boolean }) => useMascotMood(props), { initialProps: { busy: false, waiting: false } });
		expect(result.current).toBe('idle');
		rerender({ busy: true, waiting: false });
		expect(result.current).toBe('working');
		rerender({ busy: false, waiting: false });
		expect(result.current).toBe('done');
		act(() => vi.advanceTimersByTime(2500));
		expect(result.current).toBe('idle');
	});

	it('asks while the task waits on you, and never falls asleep then', () => {
		const { result } = renderHook(() => useMascotMood({ busy: false, waiting: true }));
		expect(result.current).toBe('waiting');
		act(() => vi.advanceTimersByTime(10 * 60_000));
		expect(result.current).toBe('waiting');
	});

	it('nods off after quiet minutes and wakes when you type', () => {
		const { result, rerender } = renderHook((props: { stir: string }) => useMascotMood({ busy: false, waiting: false, stir: props.stir }), { initialProps: { stir: '' } });
		act(() => vi.advanceTimersByTime(4 * 60_000));
		expect(result.current).toBe('sleeping');
		rerender({ stir: 'h' });
		expect(result.current).toBe('idle');
	});

	it('wanders along the composer and hops now and then while working, then walks home', () => {
		const offsets = new Set<string>();
		const { container, rerender } = render(<Mascot mood="working" />);
		const roam = () => container.querySelector<SVGGElement>('.am-roam')!;
		let hopped = false;
		for (let tick = 0; tick < 60; tick++) {
			act(() => vi.advanceTimersByTime(500));
			offsets.add(roam().style.transform);
			hopped ||= Boolean(container.querySelector('.am-hopper'));
		}
		expect(offsets.size).toBeGreaterThan(2);
		expect([...offsets].some((offset) => Number(/-?\d+/.exec(offset)?.[0]) <= -4)).toBe(true);
		expect(hopped).toBe(true);
		rerender(<Mascot mood="done" />);
		expect(roam().style.transform).toBe('translateX(0px)');
		expect(container.querySelector('.am-hopper')).toBeNull();
	});
});
