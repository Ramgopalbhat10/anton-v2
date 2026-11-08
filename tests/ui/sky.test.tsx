import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomSky, SKY, shuffleSky, skyAt, useSky } from '@/lib/sky';

describe('sky', () => {
	beforeEach(() => localStorage.clear());
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
});
