import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { Markdown, markdownBlocks } from '@/components/markdown';

/** The reply parsed in one piece, as before it was parsed a block at a time; the links and images as Markdown renders them. */
function whole(text: string): string {
	const html = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>);
	return html.replace(/<a ([^>]*)>/g, '<a $1 target="_blank" rel="noreferrer">');
}

const inBlocks = (text: string) => renderToStaticMarkup(<Markdown text={text} />).replace(/^<div class="sg-markdown">|<\/div>$/g, '');

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
});
