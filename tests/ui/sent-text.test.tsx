import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileLinks } from '@/components/markdown';
import { SentText } from '@/components/sent-text';
import { richRanges } from '@/lib/rich-text';

describe('Rich text', () => {
	it('finds links, a leading command and file references, leaving out the punctuation after them', () => {
		const text = '/review the change in @src/app.ts, see https://example.com/docs. Mail me@example.com about /later';
		expect(richRanges(text).map((range) => [range.kind, text.slice(range.start, range.end)])).toEqual([
			['command', '/review'],
			['file', '@src/app.ts'],
			['link', 'https://example.com/docs'],
		]);
	});
});

describe('A sent message', () => {
	it('marks its links, command and file references, and opens a file the task has', () => {
		const open = vi.fn();
		render(
			<FileLinks.Provider value={{ has: (path) => path === 'src/app.ts', open }}>
				<SentText text="/review @src/app.ts:12 and @docs/missing.md, per https://example.com/spec" />
			</FileLinks.Provider>,
		);
		const link = screen.getByRole('link', { name: 'https://example.com/spec' });
		expect(link.getAttribute('href')).toBe('https://example.com/spec');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(screen.getByText('/review').className).toContain('font-mono');
		expect(screen.getByText('@docs/missing.md').tagName).toBe('SPAN');
		fireEvent.click(screen.getByRole('button', { name: '@src/app.ts:12' }));
		expect(open).toHaveBeenCalledWith('src/app.ts', 12);
	});

	it('folds a long message to a few lines, with a chevron to show it whole and fold it back', async () => {
		// No layout here: a message's height is its lines, 19px each, and a line height reads as the default 22px.
		const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
			return (this.textContent ?? '').split('\n').length * 19;
		});
		const text = Array.from({ length: 20 }, (_, line) => `Line ${line + 1}`).join('\n');
		const { container, rerender } = render(<SentText text={text} />);
		const body = container.querySelector<HTMLElement>('.whitespace-pre-wrap')!;
		const show = await screen.findByRole('button', { name: 'Show the whole message' });
		expect(body.style.maxHeight).toBe(`${8 * 22}px`);
		expect(body.className).toContain('in-fold-fade');
		fireEvent.click(show);
		expect(body.style.maxHeight).toBe(`${20 * 19}px`);
		expect(body.className).not.toContain('in-fold-fade');
		fireEvent.click(screen.getByRole('button', { name: 'Fold the message back' }));
		expect(body.style.maxHeight).toBe(`${8 * 22}px`);
		// A short one has nothing to fold.
		rerender(<SentText text="Short" />);
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Show the whole message' })).toBeNull());
		height.mockRestore();
	});
});
