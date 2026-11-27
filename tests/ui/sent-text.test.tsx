import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileLinks, Markdown } from '@/components/content/markdown';
import { SentText } from '@/components/thread/sent-text';
import { reviewMessage } from '@/lib/review';
import { richRanges } from '@/lib/rich-text';
import { renderWithQueries } from './render';
import { withoutGuidance } from '../../src/core/review-follow-up';

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

	it('keeps file mentions with underscores, dotfiles and brackets clickable without eating adjacent links or emphasis', () => {
		const open = vi.fn();
		const existing = new Set(['src/__tests__/helpers.ts', '.github/workflows/ci.yml', 'app/routes/[id]/page.tsx', 'app/routes/[...slug]/page.tsx', 'src/_private_/index.ts']);
		const text = [
			'Check @src/__tests__/helpers.ts and @src/__tests__/helpers.ts:42, @.github/workflows/ci.yml, @app/routes/[id]/page.tsx, @app/routes/[...slug]/page.tsx.',
			'**see @src/__tests__/helpers.ts** and *check @src/_private_/index.ts*.',
			'See @alice,[the spec](https://example.com/1) and @alice[spec](https://example.com/2).',
			'Adjacent @alice*bold* and @alice**strong** and @alice~~strike~~ and @alice,_italic_.',
			'Link [see @src/__tests__/helpers.ts](https://example.com) and code `@src/__tests__/helpers.ts`.',
			'',
			'```ts',
			'@src/__tests__/helpers.ts',
			'```',
		].join('\n');

		const { container } = renderWithQueries(
			<FileLinks.Provider value={{ has: (path) => existing.has(path), open }}>
				<SentText text={text} />
			</FileLinks.Provider>,
		);

		expect([...container.querySelectorAll('strong')].map((el) => el.textContent)).toEqual(['see @src/__tests__/helpers.ts', 'strong']);
		expect([...container.querySelectorAll('em')].map((el) => el.textContent)).toEqual(['check @src/_private_/index.ts', 'bold', 'italic']);
		expect([...container.querySelectorAll('del')].map((el) => el.textContent)).toEqual(['strike']);

		const buttons = screen.getAllByRole('button', { name: '@src/__tests__/helpers.ts' });
		expect(buttons).toHaveLength(2);
		fireEvent.click(buttons[0]!);
		fireEvent.click(screen.getByRole('button', { name: '@src/__tests__/helpers.ts:42' }));
		fireEvent.click(screen.getByRole('button', { name: '@.github/workflows/ci.yml' }));
		fireEvent.click(screen.getByRole('button', { name: '@app/routes/[id]/page.tsx' }));
		fireEvent.click(screen.getByRole('button', { name: '@app/routes/[...slug]/page.tsx' }));
		fireEvent.click(screen.getByRole('button', { name: '@src/_private_/index.ts' }));

		expect(open).toHaveBeenNthCalledWith(1, 'src/__tests__/helpers.ts', undefined);
		expect(open).toHaveBeenNthCalledWith(2, 'src/__tests__/helpers.ts', 42);
		expect(open).toHaveBeenNthCalledWith(3, '.github/workflows/ci.yml', undefined);
		expect(open).toHaveBeenNthCalledWith(4, 'app/routes/[id]/page.tsx', undefined);
		expect(open).toHaveBeenNthCalledWith(5, 'app/routes/[...slug]/page.tsx', undefined);
		expect(open).toHaveBeenNthCalledWith(6, 'src/_private_/index.ts', undefined);

		expect(screen.getByRole('link', { name: 'the spec' }).getAttribute('href')).toBe('https://example.com/1');
		expect(screen.getByRole('link', { name: 'spec' }).getAttribute('href')).toBe('https://example.com/2');
		expect([...container.querySelectorAll('[data-sent-token]')].map((el) => el.textContent)).not.toContain('@alice,[the');
		const link = screen.getByRole('link', { name: 'see @src/__tests__/helpers.ts' });
		expect(link.getAttribute('href')).toBe('https://example.com');
		expect(link.querySelector('[data-sent-token]')).toBeNull();
		expect(container.querySelector('.sg-code')?.textContent).toContain('@src/__tests__/helpers.ts');
		expect(container.querySelector('.sg-code [data-sent-token]')).toBeNull();
	});

	it('namespaces footnote IDs, fragment links and aria-describedby labels across an agent reply and sent copies', () => {
		const footnoted = 'Claim.[^1]\n\n[^1]: Source note.';
		const { container } = renderWithQueries(
			<div>
				<div data-testid="reply">
					<Markdown text={footnoted} />
				</div>
				<div data-testid="copy-1">
					<SentText text={footnoted} />
				</div>
				<div data-testid="copy-2">
					<SentText text={footnoted} />
				</div>
			</div>,
		);

		const allIds = [...container.querySelectorAll('[id]')].map((el) => el.id);
		expect(allIds.length).toBeGreaterThanOrEqual(9);
		expect(new Set(allIds).size).toBe(allIds.length);

		for (const testId of ['reply', 'copy-1', 'copy-2']) {
			const block = screen.getByTestId(testId);
			const refLink = block.querySelector<HTMLAnchorElement>('a[data-footnote-ref]')!;
			const backLink = block.querySelector<HTMLAnchorElement>('a[data-footnote-backref]')!;
			const footnoteLi = block.querySelector<HTMLLIElement>('.footnotes li')!;
			const heading = block.querySelector<HTMLHeadingElement>('.footnotes h2')!;
			expect(refLink.getAttribute('href')).toBe(`#${footnoteLi.id}`);
			expect(backLink.getAttribute('href')).toBe(`#${refLink.id}`);
			expect(refLink.getAttribute('aria-describedby')).toBe(heading.id);
		}
	});

	it('renders combined multiline-check and review follow-ups without swallowing subsequent items into code blocks', () => {
		const rawFollowUp = [
			'Checks failed on your pull request (https://github.com/acme/demo/pull/9) at abc1234:',
			'',
			'- test (https://ci.test/1):',
			'  ````',
			'  Failed:',
			'  ```log',
			'  boom',
			'  ```',
			'  ````',
			'- unit (https://ci.test/2):',
			'  ````',
			'  Output:',
			'  ```log',
			'  unclosed',
			'  ````',
			'- lint: 1 error (https://ci.test/3)',
			'<anton-guidance>',
			'Find the cause, fix it.',
			'</anton-guidance>',
			'',
			'New comments on your pull request (https://github.com/acme/demo/pull/9):',
			'',
			'1. [line-1] @reviewer on src/a.ts line 1: Fix this',
			'<anton-guidance>',
			'For each one, first check it.',
			'</anton-guidance>',
		].join('\n');

		const { container } = renderWithQueries(<SentText text={withoutGuidance(rawFollowUp)} />);
		const ul = container.querySelector('ul')!;
		expect(within(ul).getAllByRole('listitem')).toHaveLength(3);
		const ol = container.querySelector('ol')!;
		expect(within(ol).getAllByRole('listitem')).toHaveLength(1);
		expect(ol.textContent).toContain('Fix this');
		for (const url of ['https://ci.test/1', 'https://ci.test/2', 'https://ci.test/3']) {
			const link = container.querySelector(`a[href="${url}"]`);
			expect(link).toBeTruthy();
			expect(link?.closest('.sg-code')).toBeNull();
		}
		expect(ol.closest('.sg-code')).toBeNull();
		expect(container.textContent).not.toContain('Find the cause');
	});

	it('prevents review comments starting with Setext underlines or non-1 ordered items from corrupting headers', () => {
		const hrMsg = reviewMessage([{ path: 'src/a.ts', side: 'new', line: 4, code: 'const x = 1;', text: '---\nCheck below' }]);
		const { container: hrContainer } = render(<SentText text={hrMsg} />);
		expect(hrContainer.querySelector('h1, h2, h3')).toBeNull();
		expect(hrContainer.querySelector('hr')).toBeTruthy();
		const hrItems = hrContainer.querySelectorAll('ol > li');
		expect(hrItems).toHaveLength(1);
		expect(hrItems[0]!.textContent).toContain('src/a.ts, line 4');
		expect(hrItems[0]!.textContent).toContain('Check below');

		const setextMsg = reviewMessage([{ path: 'src/a.ts', side: 'new', line: 4, code: 'const x = 1;', text: 'Title\n---' }]);
		const { container: setextContainer } = render(<SentText text={setextMsg} />);
		const setextItems = setextContainer.querySelectorAll('ol > li');
		expect(setextItems).toHaveLength(1);
		expect(setextItems[0]!.querySelector('p')?.textContent).toContain('src/a.ts, line 4');
		expect(setextItems[0]!.querySelector('h2')?.textContent).toBe('Title');

		const orderedMsg = reviewMessage([{ path: 'src/a.ts', side: 'new', line: 4, code: 'const x = 1;', text: '2. Second step\n3. Third step' }]);
		const { container: orderedContainer } = render(<SentText text={orderedMsg} />);
		const nestedList = orderedContainer.querySelector('ol > li > ol');
		expect(nestedList).toBeTruthy();
		expect(nestedList!.querySelectorAll('li')).toHaveLength(2);
		expect(nestedList!.textContent).toContain('Second step');
		expect(nestedList!.textContent).toContain('Third step');
	});

	it('preserves GFM footnote references and underscore-bracketed file paths without eating emphasis links', () => {
		const open = vi.fn();
		const existing = new Set(['src/app.ts', 'src/foo_(bar).ts', 'src/foo_[id].tsx']);
		const text = [
			'See @src/app.ts[^1], @src/foo_(bar).ts, and @src/foo_[id].tsx.',
			'_see @foo_[spec](https://example.com/3)',
			'',
			'[^1]: Note.',
		].join('\n');

		const { container } = renderWithQueries(
			<FileLinks.Provider value={{ has: (path) => existing.has(path), open }}>
				<SentText text={text} />
			</FileLinks.Provider>,
		);

		fireEvent.click(screen.getByRole('button', { name: '@src/app.ts' }));
		fireEvent.click(screen.getByRole('button', { name: '@src/foo_(bar).ts' }));
		fireEvent.click(screen.getByRole('button', { name: '@src/foo_[id].tsx' }));

		expect(open).toHaveBeenNthCalledWith(1, 'src/app.ts', undefined);
		expect(open).toHaveBeenNthCalledWith(2, 'src/foo_(bar).ts', undefined);
		expect(open).toHaveBeenNthCalledWith(3, 'src/foo_[id].tsx', undefined);

		expect(container.querySelector('a[data-footnote-ref]')).toBeTruthy();
		expect(container.querySelector('.footnotes')?.textContent).toContain('Note.');
		expect([...container.querySelectorAll('em')].map((el) => el.textContent)).toEqual(['see @foo']);
		expect(screen.getByRole('link', { name: 'spec' }).getAttribute('href')).toBe('https://example.com/3');
	});

	it('normalizes legacy stored check follow-ups so multiline summaries cannot swallow subsequent checks or comments', () => {
		const preGuidanceLegacy = [
			'Checks failed on your pull request (https://github.com/acme/demo/pull/9) at abc1234:',
			'- test: Failed:',
			'```log',
			'boom',
			'``` (https://ci.test/1)',
			'- unit: Output:',
			'```log',
			'unclosed (https://ci.test/2)',
			'- lint: 1 error (https://ci.test/3)',
			'Find the cause, fix it, run the relevant checks in the sandbox, then call open_pull_request to update the pull request.',
			'',
			'New comments on your pull request (https://github.com/acme/demo/pull/9):',
			'1. [line-1] @reviewer on src/a.ts line 1: Fix this',
		].join('\n');

		const postGuidanceLegacy = [
			'Checks failed on your pull request (https://github.com/acme/demo/pull/9) at abc1234:',
			'- test: Failed:',
			'```log',
			'boom',
			'``` (https://ci.test/1)',
			'- unit: Output:',
			'```log',
			'unclosed (https://ci.test/2)',
			'- lint: 1 error (https://ci.test/3)',
			'<anton-guidance>',
			'Find the cause, fix it, run the relevant checks in the sandbox, then call open_pull_request to update the pull request.',
			'</anton-guidance>',
			'',
			'New comments on your pull request (https://github.com/acme/demo/pull/9):',
			'1. [line-1] @reviewer on src/a.ts line 1: Fix this',
			'<anton-guidance>',
			'For each one, first check it.',
			'</anton-guidance>',
		].join('\n');

		const { container: preContainer } = renderWithQueries(<SentText text={preGuidanceLegacy} />);
		const preUl = preContainer.querySelector('ul')!;
		expect(within(preUl).getAllByRole('listitem')).toHaveLength(3);
		for (const url of ['https://ci.test/1', 'https://ci.test/2', 'https://ci.test/3']) {
			const link = preContainer.querySelector(`a[href="${url}"]`);
			expect(link).toBeTruthy();
			expect(link?.closest('.sg-code')).toBeNull();
		}
		expect(preContainer.textContent).toContain('Find the cause, fix it');
		for (const p of preContainer.querySelectorAll('p')) {
			if (p.textContent?.includes('Find the cause')) expect(p.closest('.sg-code')).toBeNull();
		}
		const preOl = preContainer.querySelector('ol')!;
		expect(within(preOl).getAllByRole('listitem')).toHaveLength(1);
		expect(preOl.textContent).toContain('Fix this');
		expect(preOl.closest('.sg-code')).toBeNull();

		const { container: postContainer } = renderWithQueries(<SentText text={withoutGuidance(postGuidanceLegacy)} />);
		const postUl = postContainer.querySelector('ul')!;
		expect(within(postUl).getAllByRole('listitem')).toHaveLength(3);
		for (const url of ['https://ci.test/1', 'https://ci.test/2', 'https://ci.test/3']) {
			const link = postContainer.querySelector(`a[href="${url}"]`);
			expect(link).toBeTruthy();
			expect(link?.closest('.sg-code')).toBeNull();
		}
		const postOl = postContainer.querySelector('ol')!;
		expect(within(postOl).getAllByRole('listitem')).toHaveLength(1);
		expect(postOl.textContent).toContain('Fix this');
		expect(postOl.closest('.sg-code')).toBeNull();
	});

	it('preserves Markdown escape parity at mention boundaries while keeping literal backslashes in paths', () => {
		const escapeSample = '@foo\\*bar* and @foo\\_baz_ and @foo\\[link](https://example.com) and @src\\app.ts';
		const { container: replyContainer } = renderWithQueries(<Markdown text={escapeSample} />);
		const { container: sentContainer } = renderWithQueries(<SentText text={escapeSample} />);

		expect(replyContainer.querySelectorAll('em')).toHaveLength(0);
		expect(sentContainer.querySelectorAll('em')).toHaveLength(0);
		expect([...replyContainer.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['https://example.com']);
		expect([...sentContainer.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['https://example.com']);
		expect(sentContainer.textContent).toBe(replyContainer.textContent);

		const tokens = [...sentContainer.querySelectorAll('[data-sent-token="file"]')].map((el) => el.textContent);
		expect(tokens).toEqual(['@foo', '@foo', '@foo', '@src\\app.ts']);
	});
});
