import { createContext, Fragment, memo, useContext, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Links leave the app; raw HTML in replies is never rendered (react-markdown's
 * default). Images become links, so a reply can't make the browser load a URL
 * on its own, which would let anything the agent read leak out in the URL.
 */
const InLink = createContext(false);

const components: Components = {
	a: ({ node: _node, ...props }) => (
		<InLink.Provider value={true}>
			<a {...props} target="_blank" rel="noreferrer" />
		</InLink.Provider>
	),
	// Inside a link (a README's badges) the image's text joins that link, since links can't nest.
	img: function Img({ src, alt }) {
		const inLink = useContext(InLink);
		if (typeof src !== 'string' || !src) return null;
		if (inLink) return <>{alt || src}</>;
		return (
			<a href={src} target="_blank" rel="noreferrer">
				{alt || src}
			</a>
		);
	},
};

const plugins = [remarkGfm];

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that can carry on the block before a blank line: an indented line, a list item, a quote or a table row. */
const CONTINUES = /^(\s|[*+-](\s|$)|\d{1,9}[.)](\s|$)|>|\|)/;
/** What can tie blocks together across a blank line: link references, footnotes, and HTML comments or raw blocks. */
const SPANNING = /^ {0,3}\[[^\]]+\]:|\[\^|<(!--|!\[CDATA\[|\?|pre|script|style|textarea)/im;

/**
 * Splits Markdown into top-level blocks that parse the same apart as
 * together: at a blank line, outside fenced code, before a line that starts
 * a fresh block. Text that ties blocks together (references, footnotes, raw
 * HTML that can span blank lines) stays whole.
 */
export function markdownBlocks(text: string): string[] {
	if (SPANNING.test(text)) return [text];
	const lines = text.split('\n');
	const blocks: string[] = [];
	let start = 0;
	let fence: string | null = null;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = null;
			continue;
		}
		if (marker) {
			fence = marker;
		} else if (index > start && line.trim() && !lines[index - 1].trim() && !CONTINUES.test(line)) {
			blocks.push(lines.slice(start, index).join('\n'));
			start = index;
		}
	}
	blocks.push(lines.slice(start).join('\n'));
	return blocks;
}

const Block = memo(function Block({ text }: { text: string }) {
	return (
		<ReactMarkdown remarkPlugins={plugins} components={components}>
			{text}
		</ReactMarkdown>
	);
});

/**
 * Agent replies as GitHub-flavored markdown: headings, lists, tables, links
 * and code blocks. Parsing is the expensive part, so a reply is parsed a
 * block at a time and a block that has not changed is not parsed again:
 * while a reply streams, only its last block is.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	const blocks = useMemo(() => markdownBlocks(text), [text]);
	return (
		<div className="sg-markdown">
			{/* Joined by the line break react-markdown puts between blocks, so the page is the same as in one piece. */}
			{blocks.map((block, index) => (
				<Fragment key={index}>
					{index > 0 ? '\n' : null}
					<Block text={block} />
				</Fragment>
			))}
		</div>
	);
});
