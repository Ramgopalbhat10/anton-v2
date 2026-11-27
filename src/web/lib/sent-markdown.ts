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

type HastNode = {
	type: string;
	properties?: {
		id?: string;
		ariaDescribedBy?: string[] | string;
	};
	children?: HastNode[];
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
// Stop before whitespace, `@`, inline code, autolink/HTML delimiters, table pipes, or `*`/`~` emphasis/strikethrough delimiters.
const isStopChar = (code: number | null) =>
	code === null ||
	code < 0 ||
	code === 64 ||
	code === 96 ||
	code === 60 ||
	code === 62 ||
	code === 124 ||
	code === 42 ||
	code === 126 ||
	/\s/.test(String.fromCharCode(code));
// Characters that can appear inside a path (like `__tests__`, `foo.ts`) without being left dangling as trailing punctuation or emphasis.
const isTrailable = (code: number | null) => code !== null && code > 0 && /[.,;:!?'"}_]/.test(String.fromCharCode(code));
const isPunctTrail = (code: number | null) => code !== null && code > 0 && /[.,;:!?'"}]/.test(String.fromCharCode(code));

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

					// Consume a balanced `[...]` or `(...)` group within the token; abort on whitespace, stop chars, or link syntax `](` / `][`.
					const balancedGroup = (openCode: number, closeCode: number): Construct => ({
						partial: true,
						tokenize(attemptEffects, attemptOk, attemptNok) {
							let depth = 0;
							const startGroup: State = (code) => {
								if (code !== openCode) return attemptNok(code);
								depth = 1;
								attemptEffects.consume(code);
								return openCode === 91 ? afterOpenBracket : step;
							};
							const afterOpenBracket: State = (code) => {
								// Do not swallow GFM footnote references like `@src/app.ts[^1]`.
								if (code === 94) return attemptNok(code);
								return step(code);
							};
							const afterClose: State = (code) => {
								if (openCode === 91 && (code === 40 || code === 91)) return attemptNok(code);
								hasBody = true;
								return attemptOk(code);
							};
							const step: State = (code) => {
								if (isStopChar(code)) return attemptNok(code);
								if (code === openCode) {
									depth += 1;
									attemptEffects.consume(code);
									return step;
								}
								if (code === closeCode) {
									depth -= 1;
									attemptEffects.consume(code);
									if (depth === 0) return afterClose;
									return step;
								}
								attemptEffects.consume(code);
								return step;
							};
							return startGroup;
						},
					});

					// Consume trailable chars only when followed by a solid mention character, and never bridge trailing punctuation into `[`, `(`, or `_`.
					const trailAttempt: Construct = {
						partial: true,
						tokenize(attemptEffects, attemptOk, attemptNok) {
							let sawPunct = false;
							const step: State = (code) => {
								if (!sawPunct && code === 91) return attemptEffects.attempt(balancedGroup(91, 93), attemptOk, attemptNok)(code);
								if (!sawPunct && code === 40) return attemptEffects.attempt(balancedGroup(40, 41), attemptOk, attemptNok)(code);
								if (isStopChar(code) || code === 91 || code === 93 || code === 40 || code === 41) return attemptNok(code);
								if (sawPunct && code === 95) return attemptNok(code);
								if (isTrailable(code)) {
									if (isPunctTrail(code)) sawPunct = true;
									attemptEffects.consume(code);
									return step;
								}
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
						if (isStopChar(code) || code === 93 || code === 41) return done(code);
						if (code === 91) return effects.attempt(balancedGroup(91, 93), body, done)(code);
						if (code === 40) return effects.attempt(balancedGroup(40, 41), body, done)(code);
						if (isTrailable(code)) return effects.attempt(trailAttempt, body, done)(code);
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

/** Namespaces GFM's hardcoded `footnote-label` heading id and `aria-describedby` target per bubble. */
export function rehypeNamespaceFootnoteLabel(prefix: string) {
	const labelId = `${prefix}footnote-label`;
	return (tree: HastNode) => {
		function walk(node: HastNode) {
			if (node.properties) {
				if (node.properties.id === 'footnote-label') node.properties.id = labelId;
				const described = node.properties.ariaDescribedBy;
				if (Array.isArray(described)) {
					node.properties.ariaDescribedBy = described.map((item) => (item === 'footnote-label' ? labelId : item));
				} else if (described === 'footnote-label') {
					node.properties.ariaDescribedBy = labelId;
				}
			}
			if (node.children) {
				for (const child of node.children) walk(child);
			}
		}
		walk(tree);
	};
}

export const sentMarkdownPlugins: PluggableList = [remarkGfm, remarkStripHtmlComments, remarkSentTokens, remarkSoftBreaks];
