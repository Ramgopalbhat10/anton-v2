import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomSky, resetSky, setSkyMode, SKY, shuffleSky, skyAt, useSky } from '@/lib/sky';

describe('sky', () => {
	beforeEach(() => {
		localStorage.clear();
		resetSky();
	});
	afterEach(() => vi.unstubAllGlobals());
	it('picks a different picture at random', () => {
		for (const value of [0, 0.5, 0.999]) expect(randomSky(SKY[3], () => value).slug).not.toBe(SKY[3].slug);
	});
	it('swaps every sky on the page for a random picture, and keeps it in this browser', () => {
		const shell = renderHook(() => useSky());
		const credit = renderHook(() => useSky());
		const before = shell.result.current;
		expect(before.slug).toBe(skyAt(new Date()).slug);
		act(() => shuffleSky());
		expect(shell.result.current.slug).not.toBe(before.slug);
		expect(credit.result.current.slug).toBe(shell.result.current.slug);
		expect(JSON.parse(localStorage.getItem('anton.sky.pick')!).slug).toBe(shell.result.current.slug);
	});
	it('shows NASA’s picture of the day when chosen, asking the server once, and goes back to the hour’s picture', async () => {
		const picture = { date: '2026-11-09', title: 'Rigel and the Witch Head', credit: 'A. Astronomer, via NASA APOD', link: 'https://science.nasa.gov/apod/x', image: '/api/sky/today/image?d=2026-11-09' };
		const fetch = vi.fn(async () => new Response(JSON.stringify({ picture })));
		vi.stubGlobal('fetch', fetch);
		const sky = renderHook(() => useSky());
		expect(sky.result.current.slug).toBe(skyAt(new Date()).slug);
		act(() => setSkyMode('daily'));
		await waitFor(() => expect(sky.result.current.title).toBe('Rigel and the Witch Head'));
		expect(sky.result.current.src).toBe(picture.image);
		expect(sky.result.current.link).toBe(picture.link);
		expect(localStorage.getItem('anton.sky.mode')).toBe('daily');
		renderHook(() => useSky());
		expect(fetch).toHaveBeenCalledTimes(1);
		act(() => setSkyMode('hourly'));
		expect(sky.result.current.slug).toBe(skyAt(new Date()).slug);
	});
	it('keeps the hourly picture when there is no picture of the day', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ picture: null })));
		vi.stubGlobal('fetch', fetch);
		const sky = renderHook(() => useSky());
		act(() => setSkyMode('daily'));
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		expect(sky.result.current.slug).toBe(skyAt(new Date()).slug);
	});
});
