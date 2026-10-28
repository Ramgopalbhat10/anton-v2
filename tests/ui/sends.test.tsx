import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PendingMessage, useSends } from '@/components/sent-text';

describe('sends', () => {
	it('shows a message waiting on its files, and the one that takes over from it does not rise again', () => {
		const { result } = renderHook(() => useSends());
		act(() => result.current.onPending({ text: 'Read this', attaching: 'notes.pdf' }));
		expect(result.current.pending).toEqual({ text: 'Read this', attaching: 'notes.pdf' });

		act(() => result.current.onPending('sent'));
		expect(result.current.pending).toBeNull();
		expect(result.current.rises('local:1', false)).toBe(false);
		// Asked again as the conversation draws again, it answers the same.
		expect(result.current.rises('local:1', false)).toBe(false);
		// The next message you send rises in; one from the server, or the conversation's first, does not.
		expect(result.current.rises('local:2', false)).toBe(true);
		expect(result.current.rises('local:2', false)).toBe(true);
		expect(result.current.rises('msg_9', false)).toBe(false);
		expect(result.current.rises('local:3', true)).toBe(false);
	});

	it('says what it is attaching under the message', () => {
		render(<PendingMessage pending={{ text: 'Read this', attaching: '2 files' }} />);
		expect(screen.getByText('Read this')).toBeTruthy();
		expect(screen.getByText(/Attaching 2 files/)).toBeTruthy();
	});
});
