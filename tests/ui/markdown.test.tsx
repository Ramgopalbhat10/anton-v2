import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { components, fileRef, Markdown, markdownBlocks } from '@/components/markdown';

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
});
