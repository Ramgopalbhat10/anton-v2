import type { Element, Root, RootContent } from 'hast';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified, type PluggableList } from 'unified';

// Keep the same prefix on sanitized IDs/names and links to those targets.
const clobberPrefix = 'user-content-';

const inlineMarkdown = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

/**
 * READMEs sometimes put Markdown badges/emphasis inside HTML wrappers. CommonMark
 * leaves that text raw. Parse only text originating inside an HTML element, not
 * ordinary Markdown (where escaped punctuation must remain escaped) or code.
 * Sanitization runs AFTER this pass, including anything this parser produces.
 */
function markdownInHtml() {
	return (tree: Root, file: { value: unknown }) => {
		const source = String(file.value);
		function walk(parent: Root | Element, insideHtml = false) {
			if (parent.type === 'element') {
				if (['pre', 'code', 'script', 'style', 'textarea'].includes(parent.tagName)) return;
				const offset = parent.position?.start.offset;
				insideHtml ||= offset !== undefined && source[offset] === '<';
			}
			parent.children = parent.children.flatMap((child): RootContent[] => {
				if (child.type === 'element') walk(child, insideHtml);
				if (child.type !== 'text' || !insideHtml || !/[!*_[`~]/.test(child.value)) return [child];
				const start = child.position?.start.offset;
				const end = child.position?.end.offset;
				if (start === undefined || end === undefined || source.slice(start, end) !== child.value) return [child];
				const parsed = inlineMarkdown.runSync(inlineMarkdown.parse(child.value)) as Root;
				// Inline wrappers must not acquire nested paragraphs. Block Markdown is
				// left alone; it needs blank lines in the document, just as on GitHub.
				if (parsed.children.length !== 1 || parsed.children[0].type !== 'element' || parsed.children[0].tagName !== 'p') return [child];
				return parsed.children[0].children;
			});
		}
		walk(tree);
	};
}

/** Run after sanitization: every local target received this prefix, even IDs
 * already prefixed by remark-rehype (footnotes). Do not deduplicate it. Leaving
 * the original fragment encoded preserves spaces, Unicode and literal `%` IDs.
 */
function documentFragments() {
	return (tree: Root) => {
		function walk(parent: Root | Element) {
			for (const child of parent.children) {
				if (child.type !== 'element') continue;
				const href = child.properties.href;
				if (typeof href === 'string' && href.startsWith('#') && href.length > 1) {
					child.properties.href = `#${clobberPrefix}${href.slice(1)}`;
				}
				walk(child);
			}
		}
		walk(tree);
	};
}

/** Opt-in for document/file previews only. Never enable raw HTML in agent replies. */
export const documentPlugins: PluggableList = [rehypeRaw, markdownInHtml, [rehypeSanitize, {
	...defaultSchema,
	clobberPrefix,
	// Unsupported active content must disappear, not leave CSS/script text in the document.
	strip: [...(defaultSchema.strip ?? []), 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template'],
}], documentFragments];
