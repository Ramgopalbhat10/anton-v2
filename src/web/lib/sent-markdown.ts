import remarkGfm from 'remark-gfm';
import type { PluggableList, Processor } from 'unified';

type MdNode = {
	type: string;
	value?: string;
	children?: MdNode[];
	data?: {
		hName?: string;
		hProperties?: Record<string, string>;
		hChildren?: Array<{ type: 'text'; value: string }>;
	};
};

type Token = { type: string };
type State = (code: number | null) => State | undefined;
type Effects = {
	enter: (type: string) => Token;
	exit: (type: string) => Token;
	consume: (code: number | null) => void;
	attempt: (construct: Construct | Construct[], ok: State, nok: State) => State;
};
type TokenizeContext = {
	previous: number | null;
	now: () => { offset: number };
};
type Construct = {
	name?: string;
	partial?: boolean;
	tokenize: (this: TokenizeContext, effects: Effects, ok: State, nok: State) => State;
};
type CompileContext = {
	enter: (node: MdNode, token: Token) => void;
	exit: (token: Token) => void;
	sliceSerialize: (token: Token) => string;
	stack: MdNode[];
};

const SKIP_CONTAINERS = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'definition', 'html']);

const isSpace = (code: number | null) => code === null || code < 0 || /\s/.test(String.fromCharCode(code));
const isCmdChar = (code: number | null) => code !== null && code > 0 && /[\w-]/.test(String.fromCharCode(code));
// Stop before whitespace, another `@`, inline code, autolink/HTML delimiters, or table pipes.
const isStopChar = (code: number | null) =>
	code === null || code < 0 || code === 64 || code === 96 || code === 60 || code === 62 || code === 124 || /\s/.test(String.fromCharCode(code));
// Characters that can appear inside a path (like `__tests__`, `foo.ts`, `*`) without being left dangling as trailing punctuation or emphasis.
const isTrailable = (code: number | null) => code !== null && code > 0 && /[.,;:!?'"\}*~_]/.test(String.fromCharCode(code));

function sentTokensSyntax(): { text: Record<number, Construct> } {
	return {
		text: {
			47: {
				name: 'sentCommand',
				tokenize(effects, ok, nok) {
					if (this.now().offset !== 0) return nok;
					let count = 0;
					const start: State = (code) => {
						effects.enter('sentCommand');
						effects.consume(code);
						return body;
					};
					const body: State = (code) => {
						if (isCmdChar(code)) {
							count += 1;
							effects.consume(code);
							return body;
						}
						if (count > 0 && isSpace(code)) {
							effects.exit('sentCommand');
							return ok(code);
						}
						return nok(code);
					};
					return start;
				},
			},
			64: {
				name: 'sentFile',
				tokenize(effects, ok, nok) {
					if (!isSpace(this.previous)) return nok;
					let hasBody = false;
					let bracketDepth = 0;
					let parenDepth = 0;

					// Consume a run of trailable characters only when a solid mention character follows, so trailing punctuation or closing emphasis rewinds in O(N).
					const trailAttempt: Construct = {
						partial: true,
						tokenize(attemptEffects, attemptOk, attemptNok) {
							let bDepth = bracketDepth;
							let pDepth = parenDepth;
							const step: State = (code) => {
								if (isStopChar(code)) return attemptNok(code);
								if (code === 93 && bDepth === 0) return attemptNok(code);
								if (code === 41 && pDepth === 0) return attemptNok(code);
								if (isTrailable(code)) {
									attemptEffects.consume(code);
									return step;
								}
								if (code === 91) bDepth += 1;
								else if (code === 93) bDepth -= 1;
								else if (code === 40) pDepth += 1;
								else if (code === 41) pDepth -= 1;
								bracketDepth = bDepth;
								parenDepth = pDepth;
								hasBody = true;
								attemptEffects.consume(code);
								return attemptOk;
							};
							return step;
						},
					};

					const start: State = (code) => {
						effects.enter('sentFile');
						effects.consume(code);
						return body;
					};
					const done: State = (code) => {
						if (!hasBody) return nok(code);
						effects.exit('sentFile');
						return ok(code);
					};
					const body: State = (code) => {
						if (isStopChar(code)) return done(code);
						if (code === 93 && bracketDepth === 0) return done(code);
						if (code === 41 && parenDepth === 0) return done(code);
						if (isTrailable(code)) return effects.attempt(trailAttempt, body, done)(code);
						if (code === 91) bracketDepth += 1;
						else if (code === 93) bracketDepth -= 1;
						else if (code === 40) parenDepth += 1;
						else if (code === 41) parenDepth -= 1;
						hasBody = true;
						effects.consume(code);
						return body;
					};
					return start;
				},
			},
		},
	};
}

function exitSentToken(kind: 'command' | 'file') {
	return function (this: CompileContext, token: Token) {
		const value = this.sliceSerialize(token);
		const node = this.stack[this.stack.length - 1]!;
		node.value = value;
		node.data = {
			hName: 'span',
			hProperties: { 'data-sent-token': kind, 'data-sent-value': value },
			hChildren: [{ type: 'text', value }],
		};
		this.exit(token);
	};
}

function sentTokensFromMarkdown() {
	return {
		enter: {
			sentCommand(this: CompileContext, token: Token) {
				this.enter({ type: 'sentToken', value: '' }, token);
			},
			sentFile(this: CompileContext, token: Token) {
				this.enter({ type: 'sentToken', value: '' }, token);
			},
		},
		exit: {
			sentCommand: exitSentToken('command'),
			sentFile: exitSentToken('file'),
		},
	};
}

/** Tokenizes leading `/command` and `@file` mentions before Markdown emphasis can split paths, then unwraps tokens inside code, links and HTML. */
export function remarkSentTokens(this: Processor) {
	const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
	(data.micromarkExtensions ??= []).push(sentTokensSyntax());
	(data.fromMarkdownExtensions ??= []).push(sentTokensFromMarkdown());
	return (tree: MdNode) => {
		function walk(parent: MdNode, insideSkip: boolean) {
			if (!parent.children) return;
			const skip = insideSkip || SKIP_CONTAINERS.has(parent.type);
			for (let index = 0; index < parent.children.length; index++) {
				const child = parent.children[index]!;
				if (child.type === 'sentToken' && skip) {
					parent.children[index] = { type: 'text', value: child.value ?? '' };
				} else {
					walk(child, skip);
				}
			}
		}
		walk(tree, false);
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
