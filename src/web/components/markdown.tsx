import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Links leave the app; raw HTML in replies is never rendered (react-markdown's
 * default). Images become links, so a reply can't make the browser load a URL
 * on its own, which would let anything the agent read leak out in the URL.
 */
const components: Components = {
	a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
	img: ({ src, alt }) =>
		typeof src === 'string' && src ? (
			<a href={src} target="_blank" rel="noreferrer">
				{alt || src}
			</a>
		) : null,
};

/** Agent replies as GitHub-flavored markdown: headings, lists, tables, links and code blocks. */
export function Markdown({ text }: { text: string }) {
	return (
		<div className="sg-markdown">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
}
