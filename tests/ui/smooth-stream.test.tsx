import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeSliceEnd, useSmoothText } from '@/lib/smooth-stream';

function Display({ text, streaming }: { text: string; streaming: boolean }) {
	const visible = useSmoothText(text, streaming);
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

	it('smoothly paces appended bursts across animation frames while streaming, then snaps on finish', () => {
		const frames: Array<FrameRequestCallback> = [];
		let now = 100;
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			frames.push(cb);
			return frames.length;
		});
		vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

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

		// Step frame 2: reveals more text monotonically.
		act(() => {
			now += 16;
			frames.shift()!(now);
		});
		const afterFrame2 = screen.getByTestId('out').textContent ?? '';
		expect(afterFrame2.length).toBeGreaterThan(afterFrame1.length);
		expect(afterFrame2.length).toBeLessThan(burst.length);

		// Finishing snaps immediately to the complete text.
		view.rerender(<Display text={burst} streaming={false} />);
		expect(screen.getByTestId('out').textContent).toBe(burst);
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
