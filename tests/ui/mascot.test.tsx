import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMascotMood } from '@/components/mascot';

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
});
