import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeSliceEnd, useSmoothText } from '@/lib/smooth-stream';

function Display({ text, streaming, minIntervalMs = 0 }: { text: string; streaming: boolean; minIntervalMs?: number }) {
	const visible = useSmoothText(text, streaming, minIntervalMs);
	return <div data-testid="out">{visible}</div>;
}

describe('useSmoothText', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns non-streaming text immediately without animation', () => {
		const raf = vi.spyOn(window, 'requestAnimationFrame');
		const view = render(<Display text="Hello" streaming={false} />);
		expect(screen.getByTestId('out').textContent).toBe('Hello');
		view.rerender(<Display text="Hello, world! Here is a full paragraph." streaming={false} />);
		expect(screen.getByTestId('out').textContent).toBe('Hello, world! Here is a full paragraph.');
		expect(raf).not.toHaveBeenCalled();
	});

	it('does not replay text already present on mount when streaming', () => {
		render(<Display text="Already streamed content from before mount." streaming />);
		expect(screen.getByTestId('out').textContent).toBe('Already streamed content from before mount.');
	});

	it('smoothly paces appended bursts across animation frames and drains the tail on finish without jumping', () => {
		const frames: Array<FrameRequestCallback> = [];
		let now = 100;
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			frames.push(cb);
			return frames.length;
		});
		const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

		const start = 'First chunk.';
		const burst = `${start} ${'Smoothly streamed words arriving in a big burst from the model. '.repeat(4)}`;
		const view = render(<Display text={start} streaming />);
		expect(screen.getByTestId('out').textContent).toBe(start);

		view.rerender(<Display text={burst} streaming />);
		// Immediately after burst arrives, it holds at the previous cursor before rAF advances.
		expect(screen.getByTestId('out').textContent).toBe(start);
		expect(frames.length).toBe(1);

		// Step frame 1: reveals a partial slice, not the entire burst at once.
		act(() => {
			now += 16;
			frames.shift()!(now);
		});
		const afterFrame1 = screen.getByTestId('out').textContent ?? '';
		expect(afterFrame1.length).toBeGreaterThan(start.length);
		expect(afterFrame1.length).toBeLessThan(burst.length);
		expect(burst.startsWith(afterFrame1)).toBe(true);

		// Finishing drains the remaining tail across rAF frames instead of jumping at once.
		view.rerender(<Display text={burst} streaming={false} />);
		expect(screen.getByTestId('out').textContent).toBe(afterFrame1);
		let steps = 0;
		while (frames.length > 0 && steps < 30) {
			act(() => {
				now += 16;
				frames.shift()!(now);
			});
			steps++;
		}
		expect(steps).toBeGreaterThan(1);
		expect(screen.getByTestId('out').textContent).toBe(burst);
		expect(cancel).not.toHaveBeenCalled();
	});

	it('cancels active animation frame when streaming text resets to a non-prefix and animates subsequent appends from the replacement', () => {
		const frames: Array<FrameRequestCallback> = [];
		let nextId = 0;
		let now = 100;
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			frames.push(cb);
			return ++nextId;
		});
		const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

		const view = render(<Display text="Start" streaming />);
		view.rerender(<Display text="Start plus more streaming words..." streaming />);
		expect(frames.length).toBe(1);

		const replacement = 'Completely replaced text';
		view.rerender(<Display text={replacement} streaming />);
		expect(cancel).toHaveBeenCalledWith(1);
		expect(screen.getByTestId('out').textContent).toBe(replacement);
		// Drop the canceled callback as the browser would.
		frames.shift();

		const extended = `${replacement} followed by newly streamed words from the replacement prefix.`;
		view.rerender(<Display text={extended} streaming />);
		expect(screen.getByTestId('out').textContent).toBe(replacement);
		expect(frames.length).toBe(1);

		act(() => {
			now += 16;
			frames.shift()!(now);
		});
		const afterAppend = screen.getByTestId('out').textContent ?? '';
		expect(afterAppend.length).toBeGreaterThan(replacement.length);
		expect(afterAppend.length).toBeLessThan(extended.length);
		expect(extended.startsWith(afterAppend)).toBe(true);
	});

	it('throttles emissions to minIntervalMs for large blocks while still catching up cleanly', () => {
		const frames: Array<FrameRequestCallback> = [];
		let now = 1000;
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			frames.push(cb);
			return frames.length;
		});
		vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

		const start = 'Header\n';
		const extended = `${start}${'| col1 | col2 | col3 |\n'.repeat(20)}`;
		const view = render(<Display text={start} streaming minIntervalMs={200} />);
		view.rerender(<Display text={extended} streaming minIntervalMs={200} />);

		// First frame emits immediately and records timestamp.
		act(() => {
			frames.shift()!(now);
		});
		const afterFirst = screen.getByTestId('out').textContent ?? '';
		expect(afterFirst.length).toBeGreaterThan(start.length);
		expect(afterFirst.length).toBeLessThan(extended.length);

		// Intermediate frames before 200ms elapse skip updating state.
		for (let step = 0; step < 5; step++) {
			act(() => {
				now += 16;
				frames.shift()!(now);
			});
			expect(screen.getByTestId('out').textContent).toBe(afterFirst);
		}

		// Once 200ms has elapsed, the next frame advances.
		act(() => {
			now += 140;
			frames.shift()!(now);
		});
		expect((screen.getByTestId('out').textContent ?? '').length).toBeGreaterThan(afterFirst.length);
	});

	it('respects prefers-reduced-motion by showing bursts immediately', () => {
		vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
		const view = render(<Display text="Start" streaming />);
		const burst = 'Start plus a large burst of streaming text.';
		view.rerender(<Display text={burst} streaming />);
		expect(screen.getByTestId('out').textContent).toBe(burst);
	});

	it('never splits a UTF-16 surrogate pair', () => {
		const text = 'Hi 🚀 there';
		// Index 3 is the high surrogate of 🚀 (at 3..4).
		expect(safeSliceEnd(text, 4)).toBe(5);
		expect(text.slice(0, safeSliceEnd(text, 4))).toBe('Hi 🚀');
	});
});
