import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileLinks } from '@/components/content/markdown';
import { SentText } from '@/components/thread/sent-text';
import { reviewMessage } from '@/lib/review';
import { richRanges } from '@/lib/rich-text';
import { renderWithQueries } from './render';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

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
		expect(screen.getByText('/review').className).toContain('text-(--accent-text)');
		expect(screen.getByText('/review').getAttribute('data-sent-token')).toBe('command');
		expect(screen.getByText('@docs/missing.md').tagName).toBe('SPAN');
		expect(screen.getByText('@docs/missing.md').getAttribute('data-sent-token')).toBe('file');
		const fileButton = screen.getByRole('button', { name: '@src/app.ts:12' });
		expect(fileButton.getAttribute('data-sent-token')).toBe('file');
		fireEvent.click(fileButton);
		expect(open).toHaveBeenCalledWith('src/app.ts', 12);
	});

	it('folds a long message to a few lines, with a chevron to show it whole and fold it back', async () => {
		// No layout here: a message's height is its rendered lines, 19px each, and a line height reads as the default 22px.
		const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
			return (this.querySelectorAll('br').length + 1) * 19;
		});
		const text = Array.from({ length: 20 }, (_, line) => `Line ${line + 1}`).join('\n');
		const { container, rerender } = render(<SentText text={text} />);
		const body = container.querySelector<HTMLElement>('[data-sent-body]')!;
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

	it('re-measures fold heights when the inner Markdown content resizes asynchronously', async () => {
		const observed: Element[] = [];
		let notify: ResizeObserverCallback | null = null;
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(cb: ResizeObserverCallback) {
					notify = cb;
				}
				observe(target: Element) {
					observed.push(target);
				}
				unobserve() {}
				disconnect() {}
			},
		);

		let currentHeight = 100;
		vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
			return this.hasAttribute('data-sent-body') ? currentHeight : 0;
		});

		const { container } = render(<SentText text="Short at first" />);
		const body = container.querySelector<HTMLElement>('[data-sent-body]')!;
		const inner = container.querySelector<HTMLElement>('.sg-markdown--sent')!;
		expect(observed).toContain(body);
		expect(observed).toContain(inner);
		expect(screen.queryByRole('button', { name: 'Show the whole message' })).toBeNull();

		currentHeight = 360;
		act(() => {
			notify?.([], {} as ResizeObserver);
		});
		const show = await screen.findByRole('button', { name: 'Show the whole message' });
		expect(body.style.maxHeight).toBe(`${8 * 22}px`);
		fireEvent.click(show);
		expect(body.style.maxHeight).toBe('360px');

		currentHeight = 480;
		act(() => {
			notify?.([], {} as ResizeObserver);
		});
		expect(body.style.maxHeight).toBe('480px');
	});

	it('renders copied agent Markdown with headings, inline file links, fenced code, tables, lists, blockquotes and link-only images', () => {
		const open = vi.fn();
		const markdown = [
			'## Summary',
			'',
			'Updated `src/app.ts:42` with **bold** and *italic* notes. See [the spec](https://example.com/spec).',
			'',
			'> Quoted context',
			'',
			'- Bullet item',
			'- [x] Checked task',
			'',
			'1. First ordered',
			'2. Second ordered',
			'',
			'| File | Status |',
			'| --- | --- |',
			'| `src/app.ts` | Ready |',
			'',
			'```ts',
			'const answer = 42;',
			'```',
			'',
			'![diagram](https://example.com/diagram.png)',
		].join('\n');

		const { container } = renderWithQueries(
			<FileLinks.Provider value={{ has: (path) => path === 'src/app.ts', open }}>
				<SentText text={markdown} />
			</FileLinks.Provider>,
		);

		expect(screen.getByRole('heading', { level: 2, name: 'Summary' })).toBeTruthy();
		expect(container.querySelector('strong')?.textContent).toBe('bold');
		expect(container.querySelector('em')?.textContent).toBe('italic');
		expect(container.querySelector('blockquote')?.textContent).toContain('Quoted context');
		expect(container.querySelector('table')).toBeTruthy();
		expect(container.querySelector('input[type="checkbox"]')).toBeTruthy();
		expect(container.querySelectorAll('ol > li')).toHaveLength(2);
		expect(container.querySelector('.sg-code')).toBeTruthy();
		expect(container.textContent).toContain('const answer = 42;');

		fireEvent.click(screen.getByRole('button', { name: 'src/app.ts:42' }));
		expect(open).toHaveBeenCalledWith('src/app.ts', 42);

		expect(container.querySelector('img')).toBeNull();
		const picLink = screen.getByRole('link', { name: 'diagram' });
		expect(picLink.getAttribute('href')).toBe('https://example.com/diagram.png');
		expect(screen.getByRole('link', { name: 'the spec' }).getAttribute('href')).toBe('https://example.com/spec');
	});

	it('preserves single line breaks while separating paragraphs on blank lines', () => {
		const { container } = render(<SentText text={'Line 1\nLine 2\n\n**Bold**\nNext line'} />);
		const paragraphs = container.querySelectorAll('p');
		expect(paragraphs).toHaveLength(2);
		expect(paragraphs[0].querySelectorAll('br')).toHaveLength(1);
		expect(paragraphs[1].querySelector('strong')?.textContent).toBe('Bold');
		expect(paragraphs[1].querySelectorAll('br')).toHaveLength(1);
		expect(paragraphs[1].textContent).toBe('Bold\nNext line');
	});

	it('renders legacy PR review comments cleanly without breaking backtick links or showing HTML comments', () => {
		const legacy = [
			'New comments on your pull request',
			'(https://github.com/Ramgopalbhat10/anton-v2/pull/301):',
			'1. @Ramgopalbhat10 on src/web/components/projects/project-feed.tsx line 190: **Bug · low**',
			'',
			'   `indexOf` returns an offset into the lowercased string, but the code uses it to slice the original Markdown. Lowercasing can expand a character: in `İstanbul and İzmir: add the endpoint [status](https://example.com/status)`, matching “Add the endpoint” starts two characters late.',
			'2. @Ramgopalbhat10: **Anton review:** 1 problem to fix.',
			'',
			'   The latest revision fixes both previously reported cases.',
			'',
			'   <!-- anton-review -->',
			'Address each one, then call open_pull_request to update the pull request. If you disagree with one, say why in your reply.',
		].join('\n');

		const { container } = render(<SentText text={legacy} />);
		const strongs = [...container.querySelectorAll('strong')].map((el) => el.textContent);
		expect(strongs).toContain('Bug · low');
		expect(strongs).toContain('Anton review:');

		const codes = [...container.querySelectorAll('code')].map((el) => el.textContent);
		expect(codes).toContain('indexOf');
		expect(codes).toContain('İstanbul and İzmir: add the endpoint [status](https://example.com/status)');

		const links = screen.getAllByRole('link');
		expect(links).toHaveLength(1);
		expect(links[0].getAttribute('href')).toBe('https://github.com/Ramgopalbhat10/anton-v2/pull/301');

		expect(container.querySelectorAll('ol > li')).toHaveLength(2);
		expect(container.textContent).not.toContain('anton-review');
	});

	it('renders formatted PR follow-up messages and user diff review comments including 10+ items and backtick snippets', () => {
		const prFollowUp = [
			'New comments on your pull request (https://github.com/acme/demo/pull/9):',
			'',
			'1. [line-123] @reviewer on src/app.ts line 10: **Bug · high**',
			'   ',
			'   Fix this snippet:',
			'   ```ts',
			'   return value.trim();',
			'   ```',
			'',
			'For each one, first check it against the code and what the user asked for.',
		].join('\n');

		const { container: prContainer } = renderWithQueries(<SentText text={prFollowUp} />);
		const ol = prContainer.querySelector('ol')!;
		expect(within(ol).getAllByRole('listitem')).toHaveLength(1);
		expect(ol.querySelector('.sg-code')?.textContent).toContain('return value.trim();');
		expect(ol.textContent).not.toContain('For each one');
		expect(prContainer.textContent).toContain('For each one, first check it against the code');

		const comments = Array.from({ length: 10 }, (_, index) => ({
			path: `src/file-${index + 1}.ts`,
			side: 'new' as const,
			line: index + 1,
			code: index === 9 ? 'const tag = `ok`' : `const v${index + 1} = 1;`,
			text: index === 9 ? 'First line\nSecond line' : `Fix item ${index + 1}`,
		}));
		const formattedReview = reviewMessage(comments);
		const { container: reviewContainer } = render(<SentText text={formattedReview} />);
		const reviewItems = reviewContainer.querySelectorAll('ol > li');
		expect(reviewItems).toHaveLength(10);
		expect(reviewItems[9].querySelector('code')?.textContent).toBe('const tag = `ok`');
		expect(reviewItems[9].textContent).toContain('First line');
		expect(reviewItems[9].textContent).toContain('Second line');
	});

	it('enforces token boundaries and strips HTML comments while keeping raw HTML non-executable', () => {
		const open = vi.fn();
		const text = [
			'Use `@pkg/name` and `/cmd` in code, and [@src/app.ts](https://example.com) as a link.',
			'Email me@example.com or foo**@bar** or /usr/bin/env or /later.',
			'/cmd',
			'Change <Button> and Promise<string>.',
			'',
			'<!-- anton-review -->',
			'',
			'```sh',
			'/cmd @src/app.ts',
			'```',
			'',
			'<script>alert(1)</script><img src="x" onerror="alert(1)">',
		].join('\n');

		const { container } = renderWithQueries(
			<FileLinks.Provider value={{ has: (path) => path === 'src/app.ts', open }}>
				<SentText text={text} />
			</FileLinks.Provider>,
		);

		expect(container.querySelectorAll('[data-sent-token]')).toHaveLength(0);
		expect(screen.queryByRole('button', { name: /@src\/app\.ts/ })).toBeNull();
		expect(container.querySelector('script')).toBeNull();
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('string')).toBeNull();
		expect(container.textContent).toContain('Change <Button> and Promise<string>.');
		expect(container.textContent).not.toContain('anton-review');
		expect(screen.getByRole('link', { name: '@src/app.ts' }).getAttribute('href')).toBe('https://example.com');
		expect([...container.querySelectorAll('code')].map((el) => el.textContent)).toEqual(expect.arrayContaining(['@pkg/name', '/cmd']));
	});
});
