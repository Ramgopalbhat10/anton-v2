import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_DAY_MS as DAY, SCIENCE_FALLBACK, ScienceBackground, nextBackgroundDelay } from '@/components/science-background';

const daily = { url: '/api/science-background/image?id=1234567890abcdef', title: 'Nebula', date: '2026-11-08', credit: 'NASA', sourceUrl: 'https://www.nasa.gov/image-detail/nebula/', licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/' };
let visibility: DocumentVisibilityState;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
	vi.useFakeTimers(); vi.setSystemTime(0); visibility = 'visible';
	vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
	request = vi.fn(async () => new Response(JSON.stringify({ image: daily }), { headers: { 'content-type': 'application/json' } }));
	vi.stubGlobal('fetch', request);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const image = (container: HTMLElement) => container.querySelector('img')!;
const mount = async () => { let result!: ReturnType<typeof render>; await act(async () => { result = render(<ScienceBackground><button>Work</button></ScienceBackground>); }); return result; };

describe('daily NASA science background', () => {
	it('shows the daily still with exact visible credit, source, date and usage terms', async () => {
		const { container } = await mount();
		expect(request).toHaveBeenCalledTimes(1); expect(image(container).getAttribute('src')).toBe(daily.url);
		expect(screen.getByRole('link', { name: /NASA image of the day: Nebula/ }).getAttribute('href')).toBe(daily.sourceUrl);
		expect(container.querySelector('footer')?.textContent).toContain('Credit: NASA.');
		expect(screen.getByRole('link', { name: 'Usage terms' }).getAttribute('href')).toBe(daily.licenseUrl);
		expect(screen.getByRole('button', { name: 'Work' })).toBeTruthy();
	});
	it('keeps one hidden-until-loaded, decorative low-priority image', async () => {
		const { container } = await mount(); const img = image(container);
		expect(container.querySelectorAll('img')).toHaveLength(1); expect(img.closest('[aria-hidden="true"]')).toBeTruthy();
		expect(img.alt).toBe(''); expect(img.getAttribute('fetchpriority')).toBe('low'); expect(img.getAttribute('decoding')).toBe('async');
		expect(img.getAttribute('data-loaded')).toBe('false'); fireEvent.load(img); expect(img.getAttribute('data-loaded')).toBe('true');
	});
	it('shows the bundled fallback while metadata loads and when requests fail', async () => {
		request.mockImplementation(async () => { throw new Error('offline'); }); const { container } = await mount();
		expect(image(container).getAttribute('src')).toBe(SCIENCE_FALLBACK); expect(screen.getByRole('link', { name: /Space imagery: NASA/ })).toBeTruthy();
		expect(request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
	});
	it('uses bundled fallback for null metadata, non-2xx and invalid or external image URLs', async () => {
		for (const response of [new Response(JSON.stringify({ image: null })), new Response('', { status: 503 }), new Response(JSON.stringify({ image: { ...daily, url: 'https://evil.test/image.jpg' } }))]) {
			request.mockResolvedValueOnce(response); const { container, unmount } = await mount();
			expect(image(container).getAttribute('src')).toBe(SCIENCE_FALLBACK); unmount();
		}
	});
	it('switches to credited fallback on daily-image failure, without retry loops or a broken icon', async () => {
		const { container } = await mount(); fireEvent.error(image(container));
		expect(image(container).getAttribute('src')).toBe(SCIENCE_FALLBACK); expect(image(container).getAttribute('data-loaded')).toBe('false');
		expect(screen.queryByRole('link', { name: /NASA image of the day/ })).toBeNull(); fireEvent.error(image(container));
		expect(image(container).getAttribute('data-loaded')).toBe('false'); expect(request).toHaveBeenCalledTimes(1);
	});
	it('refreshes at midnight UTC, not hourly, and retains the previous daily still during an outage', async () => {
		vi.setSystemTime(DAY - 10); const { container } = await mount();
		expect(nextBackgroundDelay(DAY - 10)).toBe(10); expect(nextBackgroundDelay(0)).toBe(DAY);
		await act(async () => { vi.advanceTimersByTime(9); }); expect(request).toHaveBeenCalledTimes(1);
		request.mockRejectedValueOnce(new Error('NASA down'));
		await act(async () => { vi.advanceTimersByTime(1); }); expect(request).toHaveBeenCalledTimes(2);
		expect(image(container).getAttribute('src')).toBe(daily.url);
		await act(async () => { vi.advanceTimersByTime(3_600_000); }); expect(request).toHaveBeenCalledTimes(2);
	});
	it('updates the image and resets loaded state on a new day', async () => {
		const { container } = await mount(); fireEvent.load(image(container));
		request.mockResolvedValueOnce(new Response(JSON.stringify({ image: { ...daily, url: '/api/science-background/image?id=abcdef1234567890', title: 'Earth' } })));
		await act(async () => { vi.advanceTimersByTime(DAY); }); expect(image(container).getAttribute('src')).toContain('abcdef1234567890'); expect(image(container).getAttribute('data-loaded')).toBe('false');
	});
	it('suspends timers while hidden, skips missed days and does not refetch on same-day focus/pageshow', async () => {
		await mount();
		act(() => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }); expect(vi.getTimerCount()).toBe(0);
		await act(async () => { vi.advanceTimersByTime(5 * DAY); }); expect(request).toHaveBeenCalledTimes(1);
		await act(async () => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); }); expect(request).toHaveBeenCalledTimes(2);
		await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); }); expect(request).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
	});
	it('aborts the request and removes timers/listeners on unmount', async () => {
		const { unmount } = await mount(); const signal = request.mock.calls[0][1].signal as AbortSignal;
		unmount(); act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
		expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
	});
});
