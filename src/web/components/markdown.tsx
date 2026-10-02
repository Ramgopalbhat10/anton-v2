import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Links leave the app; raw HTML in replies is never rendered (react-markdown's default). */
const components: Components = {
	a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
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
