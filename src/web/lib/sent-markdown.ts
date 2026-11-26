import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import { TRAILING_PUNCTUATION } from '@/lib/rich-text';

type MdNode = {
	type: string;
	value?: string;
	children?: MdNode[];
	position?: { start: { offset?: number }; end: { offset?: number } };
	data?: {
		hName?: string;
		hProperties?: Record<string, string>;
		hChildren?: Array<{ type: 'text'; value: string }>;
	};
};

const SKIP_CONTAINERS = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'definition', 'html']);
const INLINE_WRAPPERS = new Set(['strong', 'emphasis', 'delete']);
const LEADING_COMMAND = /^\/[\w-]+(?=\s|$)/;
const MENTION = /(?:^|(?<=\s))@[^\s@]+/g;

function sentToken(kind: 'command' | 'file', value: string): MdNode {
	return {
		type: 'sentToken',
		data: {
			hName: 'span',
			hProperties: { 'data-sent-token': kind, 'data-sent-value': value },
			hChildren: [{ type: 'text', value }],
		},
	};
}

function endsWithSpace(node: MdNode, fallback: boolean): boolean {
	if (node.type === 'break') return true;
	if (node.type === 'text') return /\s$/.test(node.value ?? '');
	if (node.type === 'sentToken' || !node.children) return false;
	if (node.children.length === 0) return fallback;
	return endsWithSpace(node.children[node.children.length - 1]!, fallback);
}

function splitTextTokens(node: MdNode, afterSpace: boolean): MdNode[] {
	const text = node.value ?? '';
	const out: MdNode[] = [];
	let cursor = 0;

	if (node.position?.start.offset === 0) {
		const command = LEADING_COMMAND.exec(text);
		if (command) {
			out.push(sentToken('command', command[0]));
			cursor = command[0].length;
		}
	}

	MENTION.lastIndex = cursor;
	for (const match of text.matchAll(MENTION)) {
		if (match.index === 0 && !afterSpace) continue;
		const word = match[0].replace(TRAILING_PUNCTUATION, '');
		if (word.length < 2) continue;
		if (match.index > cursor) out.push({ type: 'text', value: text.slice(cursor, match.index) });
		out.push(sentToken('file', word));
		cursor = match.index + word.length;
	}

	if (cursor === 0) return [node];
	if (cursor < text.length) out.push({ type: 'text', value: text.slice(cursor) });
	return out;
}

/** Recognizes a leading `/command` and `@file` mentions in Markdown prose, skipping code, links and HTML. */
export function remarkSentTokens() {
	return (tree: MdNode) => {
		function walk(parent: MdNode, startAfterSpace: boolean) {
			if (!parent.children || SKIP_CONTAINERS.has(parent.type)) return;
			let afterSpace = startAfterSpace;
			const nextChildren: MdNode[] = [];
			for (const child of parent.children) {
				if (child.type === 'text') {
					const replaced = splitTextTokens(child, afterSpace);
					nextChildren.push(...replaced);
					afterSpace = /\s$/.test(child.value ?? '');
					continue;
				}
				if (INLINE_WRAPPERS.has(child.type)) {
					walk(child, afterSpace);
					afterSpace = endsWithSpace(child, afterSpace);
				} else {
					walk(child, true);
					afterSpace = endsWithSpace(child, false);
				}
				nextChildren.push(child);
			}
			parent.children = nextChildren;
		}
		walk(tree, true);
	};
}

/** Preserves single line breaks inside user-written prose without touching code or HTML. */
export function remarkSoftBreaks() {
	return (tree: MdNode) => {
		function walk(parent: MdNode) {
			if (!parent.children || SKIP_CONTAINERS.has(parent.type)) return;
			const nextChildren: MdNode[] = [];
			for (const child of parent.children) {
				if (child.type === 'text' && child.value && /\r?\n/.test(child.value)) {
					const parts = child.value.split(/\r?\n/);
					for (let index = 0; index < parts.length; index++) {
						if (index > 0) nextChildren.push({ type: 'break' });
						if (parts[index]) nextChildren.push({ type: 'text', value: parts[index] });
					}
					continue;
				}
				walk(child);
				nextChildren.push(child);
			}
			parent.children = nextChildren;
		}
		walk(tree);
	};
}

const HTML_COMMENT = /^<!--(?:(?!-->)[\s\S])*-->$/;

function hasVisibleContent(node: MdNode): boolean {
	if (node.type === 'text') return Boolean((node.value ?? '').trim());
	if (!node.children) return node.type !== 'break';
	return node.children.some(hasVisibleContent);
}

/** Strips Markdown HTML comment nodes (such as `<!-- anton-review -->`) so hidden markers stay hidden. */
export function remarkStripHtmlComments() {
	return (tree: MdNode) => {
		function walk(parent: MdNode) {
			if (!parent.children || SKIP_CONTAINERS.has(parent.type)) return;
			const nextChildren: MdNode[] = [];
			for (const child of parent.children) {
				if (child.type === 'html' && HTML_COMMENT.test((child.value ?? '').trim())) continue;
				walk(child);
				if (child.type === 'paragraph' && !hasVisibleContent(child)) continue;
				nextChildren.push(child);
			}
			parent.children = nextChildren;
		}
		walk(tree);
	};
}

export const sentMarkdownPlugins: PluggableList = [remarkGfm, remarkStripHtmlComments, remarkSentTokens, remarkSoftBreaks];
