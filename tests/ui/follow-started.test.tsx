import type { FlueConversationMessage } from '@flue/react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFollowOnceStarted } from '@/lib/working';

const said = { id: 'm1', role: 'user', display: 'visible', parts: [{ type: 'text', text: 'Hi', state: 'done' }] } as FlueConversationMessage;

type Props = { messages: FlueConversationMessage[]; working: boolean; changedAt: number };

function follow(initial: Props) {
	const refresh = vi.fn();
	const hook = renderHook(({ messages, working, changedAt }: Props) => useFollowOnceStarted({ historyReady: true, messages, refresh }, working, changedAt), { initialProps: initial });
	return { refresh, ...hook };
}

describe('a conversation read before it started', () => {
	afterEach(() => vi.useRealTimers());

	it('is read again while its task works, until its messages arrive', () => {
		vi.useFakeTimers();
		const { refresh, rerender } = follow({ messages: [], working: true, changedAt: 1 });
		expect(refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2000);
		expect(refresh).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(2000);
		expect(refresh).toHaveBeenCalledTimes(2);

		rerender({ messages: [said], working: true, changedAt: 1 });
		vi.advanceTimersByTime(10_000);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('is read again once its task changes, and left alone while nothing does', () => {
		vi.useFakeTimers();
		const { refresh, rerender } = follow({ messages: [], working: false, changedAt: 1 });
		vi.advanceTimersByTime(10_000);
		expect(refresh).not.toHaveBeenCalled();

		rerender({ messages: [], working: false, changedAt: 2 });
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
