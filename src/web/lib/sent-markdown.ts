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
const isAsciiPunct = (code: number | null) =>
	code !== null &&
	code > 0 &&
	((code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126));

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

					// Consume `\` only when it is not a CommonMark escape (`\` + ASCII punctuation) or hard break (`\` + whitespace/EOF).
					const backslashLiteral: Construct = {
						partial: true,
						tokenize(attemptEffects, attemptOk, attemptNok) {
							const startSlash: State = (code) => {
								if (code !== 92) return attemptNok(code);
								attemptEffects.consume(code);
								return afterSlash;
							};
							const afterSlash: State = (code) => {
								if (isStopChar(code) || isAsciiPunct(code)) return attemptNok(code);
								hasBody = true;
								return attemptOk(code);
							};
							return startSlash;
						},
					};

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
								if (code === 92) return attemptEffects.attempt(backslashLiteral, step, attemptNok)(code);
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
								if (code === 92) return attemptEffects.attempt(backslashLiteral, attemptOk, attemptNok)(code);
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
						if (code === 92) return effects.attempt(backslashLiteral, body, done)(code);
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

const LEGACY_CHECKS_HEADER = /^Checks failed on your pull request \(https?:\/\/\S+\) at [0-9a-f]{7,40}:$/;
const LEGACY_CHECKS_FOOTER = /^Find the cause, fix it, run the relevant checks in the sandbox, then call open_pull_request to update the pull request\.$/;
const LEGACY_COMMENTS_HEADER = /^New comments on your pull request \(https?:\/\/\S+\):$/;
const LEGACY_CHECK_START = /^- (.+?): (.*)$/;
const LEGACY_CHECK_URL_END = / \((https?:\/\/\S+|)\)$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

function fenceFor(text: string): string {
	let longest = 2;
	for (const match of text.matchAll(/`+/g)) {
		if (match[0].length > longest) longest = match[0].length;
	}
	return '`'.repeat(longest + 1);
}

/** Re-wraps legacy stored check follow-ups whose check URL was appended to a multiline summary line so fenced logs cannot swallow later checks or review sections. */
export function normalizeLegacyChecksFollowUp(text: string): string {
	if (!text.includes('Checks failed on your pull request (')) return text;
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const out: string[] = [];
	let changed = false;
	let fence: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const marker = FENCE_LINE.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) {
				fence = null;
			}
			out.push(line);
			continue;
		}
		if (marker) {
			fence = marker;
			out.push(line);
			continue;
		}
		if (LEGACY_CHECKS_HEADER.test(line) && i + 1 < lines.length && LEGACY_CHECK_START.test(lines[i + 1]!)) {
			let end = -1;
			let hasFooter = false;
			for (let j = i + 1; j < lines.length; j++) {
				if (j > i + 1 && LEGACY_CHECK_URL_END.test(lines[j - 1]!)) {
					if (LEGACY_CHECKS_FOOTER.test(lines[j]!)) {
						end = j;
						hasFooter = true;
						break;
					}
					if (LEGACY_COMMENTS_HEADER.test(lines[j]!)) {
						end = j;
						break;
					}
					if (lines[j] === '') {
						let next = j;
						while (next < lines.length && lines[next] === '') next++;
						if (next < lines.length && (LEGACY_COMMENTS_HEADER.test(lines[next]!) || LEGACY_CHECKS_FOOTER.test(lines[next]!))) {
							end = j;
							break;
						}
					}
				}
			}
			if (end === -1 && LEGACY_CHECK_URL_END.test(lines[lines.length - 1]!)) end = lines.length;
			if (end === -1) {
				out.push(line);
				continue;
			}

			const items: string[][] = [];
			let current = [lines[i + 1]!];
			for (let k = i + 2; k < end; k++) {
				if (LEGACY_CHECK_START.test(lines[k]!) && LEGACY_CHECK_URL_END.test(lines[k - 1]!)) {
					items.push(current);
					current = [lines[k]!];
				} else {
					current.push(lines[k]!);
				}
			}
			items.push(current);

			out.push(line, '');
			for (const item of items) {
				const startMatch = LEGACY_CHECK_START.exec(item[0]!);
				if (!startMatch) {
					out.push(...item);
					continue;
				}
				const name = startMatch[1]!.trim() || 'check';
				const firstSummary = startMatch[2]!;
				const lastLine = item[item.length - 1]!;
				const url = LEGACY_CHECK_URL_END.exec(lastLine)?.[1] ?? '';
				const summaryParts =
					item.length === 1
						? [firstSummary.replace(LEGACY_CHECK_URL_END, '')]
						: [firstSummary, ...item.slice(1, -1), lastLine.replace(LEGACY_CHECK_URL_END, '')];
				const summary = summaryParts.join('\n').trim() || 'failed';
				const link = url ? ` (${url})` : '';
				if (!summary.includes('\n')) {
					out.push(`- ${name}: ${summary}${link}`);
				} else {
					const itemFence = fenceFor(summary);
					const body = summary
						.split('\n')
						.map((summaryLine) => (summaryLine ? `  ${summaryLine}` : ''))
						.join('\n');
					out.push(`- ${name}${link}:\n  ${itemFence}\n${body}\n  ${itemFence}`);
				}
			}
			if (hasFooter) {
				out.push('', lines[end]!);
				i = end;
			} else {
				i = end - 1;
			}
			changed = true;
			continue;
		}
		out.push(line);
	}

	return changed ? out.join('\n') : text;
}

export const sentMarkdownPlugins: PluggableList = [remarkGfm, remarkStripHtmlComments, remarkSentTokens, remarkSoftBreaks];
