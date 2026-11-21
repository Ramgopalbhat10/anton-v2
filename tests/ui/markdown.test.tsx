import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { components, fileRef, Markdown, markdownBlocks, streamingParseIntervalMs } from '@/components/content/markdown';

/** Code blocks highlight through a query, so the markup renders inside a client. */
const html = (node: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

/** The reply parsed in one piece, as before it was parsed a block at a time, with the same components. */
const whole = (text: string) => html(<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>);

const inBlocks = (text: string) => html(<Markdown text={text} />).replace(/^<div class="sg-markdown">|<\/div>$/g, '');

const SAMPLES = {
	paragraphs: 'One paragraph.\n\nAnother one, with `code` and **bold**.\n\nA [link](https://example.com).',
	headings: '## What I found\n\nThe thread re-renders.\n\n### Why\n\nEvery chunk.',
	'a tight list': 'Before:\n\n- one\n- two\n- three\n\nAfter.',
	'a loose list': '- one\n\n- two\n\n  continued in the item\n\n- three\n\nAfter the list.',
	'an ordered list split by a paragraph': '1. first\n2. second\n\nA note.\n\n3. third',
	'fenced code with blank lines': 'Look:\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nDone.',
	'a tilde fence holding backticks': '~~~\n```\n\nstill code\n~~~\n\nText.',
	'an indented code block': 'Text.\n\n    indented code\n\n    more code\n\nText.',
	'a table': '| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter the table.',
	'a quote': '> quoted\n> more\n\nNot quoted.\n\n> again',
	'a thematic break': 'Above.\n\n---\n\nBelow.',
	'link references': 'See [the docs][docs].\n\nMore text.\n\n[docs]: https://example.com',
	footnotes: 'A claim.[^1]\n\nMore.\n\n[^1]: The source.',
	'an HTML comment across a blank line': 'Text.\n\n<!-- a\n\nnote -->\n\nMore.',
	'a reply still streaming': '## Plan\n\n- read the code\n- fix the hot path\n\n```ts\nconst x = memo(',
};

describe('Markdown', () => {
	for (const [name, text] of Object.entries(SAMPLES)) {
		it(`renders ${name} the same a block at a time as in one piece`, () => {
			expect(inBlocks(text)).toBe(whole(text));
		});
	}

	it('splits only where a fresh block starts', () => {
		// A list after a blank line could be carrying on one before it, so it stays with the block before.
		expect(markdownBlocks('A.\n\nB.\n\n- c\n- d\n\n- e\n\nF.')).toEqual(['A.\n', 'B.\n\n- c\n- d\n\n- e\n', 'F.']);
		expect(markdownBlocks('```\na\n\nb\n```\n\nC.')).toEqual(['```\na\n\nb\n```\n', 'C.']);
		expect(markdownBlocks('A.[^1]\n\n[^1]: b')).toEqual(['A.[^1]\n\n[^1]: b']);
	});

	it('draws fenced code as a block with its language, and mermaid as a diagram once it loads', () => {
		const code = inBlocks('```ts\nconst a = 1;\n```');
		expect(code).toContain('class="sg-code');
		expect(code).toContain('>ts<');
		expect(code).toContain('const a = 1;');
		// Until mermaid has drawn it, a diagram shows as its source.
		expect(inBlocks('```mermaid\ngraph TD; A-->B\n```')).toContain('>mermaid<');
	});

	it('reads file references from inline code', () => {
		expect(fileRef('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42 });
		expect(fileRef('./src/web/main.tsx')).toEqual({ path: 'src/web/main.tsx', line: undefined });
		expect(fileRef('package.json:3-9')).toEqual({ path: 'package.json', line: 3 });
		// A bare name without a line, or something that is not a path, stays code.
		expect(fileRef('package.json')).toBeNull();
		expect(fileRef('npm run build')).toBeNull();
		expect(fileRef('a.b')).toBeNull();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('keeps coarse reparse cadence while reveal cursor is still inside a large table even after a trailing paragraph arrives, then resumes 60Hz in the paragraph', () => {
		const frames: Array<FrameRequestCallback> = [];
		let now = 1000;
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			frames.push(cb);
			return frames.length;
		});
		vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

		const header = '| Col A | Col B | Col C | Col D |\n| --- | --- | --- | --- |\n';
		const row = (n: number) => `| row-${n}-a | row-${n}-b | row-${n}-c | row-${n}-d |\n`;
		const initialTable = `${header}${Array.from({ length: 180 }, (_, i) => row(i + 1)).join('')}`;
		const extraRows = Array.from({ length: 40 }, (_, i) => row(i + 181)).join('');
		const summaryStart = '\nSummary paragraph after the table.';
		const fullWithSummary = `${initialTable}${extraRows}${summaryStart}`;

		const client = new QueryClient();
		const view = render(
			<QueryClientProvider client={client}>
				<Markdown text={initialTable} streaming />
			</QueryClientProvider>,
		);
		expect(view.container.querySelectorAll('tbody tr').length).toBe(180);

		// Burst finishes the 220-row table AND starts a short summary paragraph.
		view.rerender(
			<QueryClientProvider client={client}>
				<Markdown text={fullWithSummary} streaming />
			</QueryClientProvider>,
		);

		// First animation frame advances into the remaining table rows (still inside the table, paragraph not yet visible).
		act(() => {
			frames.shift()!(now);
		});
		const rowsAfterFirst = view.container.querySelectorAll('tbody tr').length;
		expect(rowsAfterFirst).toBeGreaterThan(180);
		expect(rowsAfterFirst).toBeLessThan(220);
		expect(view.container.textContent).not.toContain('Summary paragraph');

		// While the reveal cursor is still inside the 220-row table, 16ms frames must NOT reparse/update the table.
		for (let step = 0; step < 5; step++) {
			act(() => {
				now += 16;
				frames.shift()!(now);
			});
			expect(view.container.querySelectorAll('tbody tr').length).toBe(rowsAfterFirst);
		}

		// Advance past the large-block cadence until the reveal cursor crosses into the summary paragraph.
		let guard = 0;
		while (frames.length > 0 && !view.container.textContent?.includes('Summary paragraph') && guard++ < 20) {
			act(() => {
				now += 260;
				frames.shift()!(now);
			});
		}
		expect(view.container.querySelectorAll('tbody tr').length).toBe(220);
		expect(view.container.textContent).toContain('Summary paragraph');

		// Once the reveal cursor is in the short trailing paragraph, 16ms frames immediately resume 60Hz pacing.
		const moreSummary = `${fullWithSummary} More streamed words arriving smoothly in the summary paragraph.`;
		view.rerender(
			<QueryClientProvider client={client}>
				<Markdown text={moreSummary} streaming />
			</QueryClientProvider>,
		);
		const lenBefore = (view.container.textContent ?? '').length;
		act(() => {
			now += 16;
			frames.shift()!(now);
		});
		const lenAfter1 = (view.container.textContent ?? '').length;
		expect(lenAfter1).toBeGreaterThan(lenBefore);
		act(() => {
			now += 16;
			frames.shift()!(now);
		});
		expect((view.container.textContent ?? '').length).toBeGreaterThan(lenAfter1);
	});

	it('throttles rich Markdown reparsing cadence for large growing blocks like long GFM tables, then restores 60Hz for later paragraphs', () => {
		expect(streamingParseIntervalMs(400)).toBe(0);
		expect(streamingParseIntervalMs(2000)).toBe(0);
		expect(streamingParseIntervalMs(4000)).toBe(80);
		const largeTable = `| Col A | Col B | Col C | Col D |\n| --- | --- | --- | --- |\n${'| value-a | value-b | value-c | value-d |\n'.repeat(200)}`;
		const trailingTable = markdownBlocks(largeTable).at(-1)!;
		expect(trailingTable.length).toBeGreaterThan(8000);
		expect(streamingParseIntervalMs(trailingTable.length)).toBeGreaterThanOrEqual(160);
		expect(streamingParseIntervalMs(trailingTable.length)).toBeLessThanOrEqual(250);

		const afterTable = `${largeTable}\nSummary paragraph after the table.`;
		const trailingParagraph = markdownBlocks(afterTable).at(-1)!;
		expect(streamingParseIntervalMs(trailingParagraph.length)).toBe(0);
	});
});
