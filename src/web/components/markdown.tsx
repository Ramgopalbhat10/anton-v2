import { createContext, useContext } from 'react';
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
