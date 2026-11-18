import type { FlueConversationMessage } from '@flue/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SentImages } from '@/components/thread/sent-images';
import { PendingMessage } from '@/components/thread/sent-text';
import { UserMessage } from '@/components/thread/user-message';
import { closeViewer } from '@/lib/viewer';
import { attachmentBlock } from '../../src/core/attachments';
import { renderWithQueries } from './render';

vi.mock('@tanstack/react-router', async (original) => ({
	...(await original<typeof import('@tanstack/react-router')>()),
	useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) => select({ location: { pathname: '/agents/s1' } }),
}));

const { OutputViewerHost } = await import('@/components/content/output-viewer');

const STORED = '/api/agents/coordinator/space_1/attachments/att_1';
// jsdom loads a data: URL at once, so the bytes the page sent stand in as a plain URL that loads when the test says.
const SENT = '/sent/pasted-134527.png';

const message = (url: string, text: string): FlueConversationMessage =>
	({
		id: 'local:1',
		role: 'user',
		display: 'visible',
		parts: [
			{ type: 'text', text },
			{ type: 'file', mediaType: 'image/png', url, filename: 'pasted-134527.png' },
		],
	}) as unknown as FlueConversationMessage;

const handedOn = [
	'Look at this screenshot',
	attachmentBlock({ name: 'pasted-134527.png', path: 'pasted-134527.png', size: 16_000, kind: 'PNG image', text: null, cut: null }, 'project'),
	attachmentBlock({ name: 'notes.pdf', path: 'notes.pdf', size: 2_048, kind: 'PDF document', text: 'Notes', cut: null }, 'project'),
].join('\n\n');

beforeEach(() => {
	// jsdom neither loads nor decodes pictures: each loads when the test says.
	HTMLImageElement.prototype.decode = vi.fn(() => Promise.resolve());
});

afterEach(() => {
	act(() => closeViewer());
});

describe('sent images', () => {
	it('holds a placeholder until a picture loads, then keeps the same picture while its source changes to the stored copy', async () => {
		const { rerender } = render(<SentImages pictures={[{ src: SENT, name: 'pasted-134527.png' }]} />);
		const button = screen.getByRole('button', { name: 'Open pasted-134527.png' });
		expect(button.className).toContain('in-sweep');
		const picture = screen.getByRole('img', { name: 'pasted-134527.png' });
		fireEvent.load(picture);
		expect(button.className).not.toContain('in-sweep');

		rerender(<SentImages pictures={[{ src: STORED, name: 'pasted-134527.png' }]} />);
		// The element stays; it shows the stored copy once that is ready, never a blank in between.
		const after = screen.getByRole('img', { name: 'pasted-134527.png' });
		expect(after).toBe(picture);
		await act(async () => {});
		expect(after.getAttribute('src')).toBe(STORED);
		expect(screen.getByRole('button', { name: 'Open pasted-134527.png' }).className).not.toContain('in-sweep');
	});

	it('shows what a message is attaching as the pictures and chips it will have, while they upload', () => {
		render(
			<PendingMessage
				pending={{ text: 'Read this', attaching: '2 files', pictures: [{ src: SENT, name: 'pasted-134527.png' }], files: [{ name: 'notes.pdf', size: 2_048 }] }}
			/>,
		);
		expect(screen.getByRole('button', { name: 'Uploading pasted-134527.png' })).toHaveProperty('disabled', true);
		expect(screen.getByText('notes.pdf')).toBeTruthy();
		expect(screen.getByText('Uploading · 2 KB')).toBeTruthy();
		expect(screen.getByText('Read this')).toBeTruthy();
	});

	it('shows a picture handed on to a thread without a chip for it, and opens it beside the chat', async () => {
		renderWithQueries(
			<>
				<UserMessage message={message(STORED, handedOn)} meta={[]} composer="s1" />
				<OutputViewerHost />
			</>,
		);
		expect(screen.queryByText('PNG image · 16 KB')).toBeNull();
		// Other files keep their chips.
		expect(screen.getByText('notes.pdf')).toBeTruthy();
		expect(screen.queryByRole('link')).toBeNull();

		fireEvent.click(screen.getByRole('button', { name: 'Open pasted-134527.png' }));
		const viewer = await screen.findByRole('complementary', { name: 'Viewing pasted-134527.png' });
		expect(viewer.querySelector(`img[src="${STORED}"]`)).toBeTruthy();
		expect(screen.getByText('Sent with a message')).toBeTruthy();
	});
});
