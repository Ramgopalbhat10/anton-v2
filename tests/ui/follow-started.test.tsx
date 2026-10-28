import type { FlueConversationMessage } from '@flue/react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFollowOnceStarted } from '@/lib/working';

const said = { id: 'm1', role: 'user', display: 'visible', parts: [{ type: 'text', text: 'Hi', state: 'done' }] } as FlueConversationMessage;

type Props = { messages: FlueConversationMessage[]; changedAt: number };

function follow(initial: Props) {
	const refresh = vi.fn();
	const hook = renderHook(({ messages, changedAt }: Props) => useFollowOnceStarted({ historyReady: true, messages, refresh }, changedAt), { initialProps: initial });
	return { refresh, ...hook };
}

describe('a conversation read before it started', () => {
	it('is read again each time the task is read again, and not before', () => {
		const { refresh, rerender } = follow({ messages: [], changedAt: 1 });
		expect(refresh).not.toHaveBeenCalled();
		rerender({ messages: [], changedAt: 1 });
		expect(refresh).not.toHaveBeenCalled();

		// The reply started: the server's state change read the task again.
		rerender({ messages: [], changedAt: 2 });
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('is left alone once its messages arrive', () => {
		const { refresh, rerender } = follow({ messages: [], changedAt: 1 });
		rerender({ messages: [said], changedAt: 2 });
		rerender({ messages: [said], changedAt: 3 });
		expect(refresh).not.toHaveBeenCalled();
	});
});
