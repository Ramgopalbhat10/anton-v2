import type { ThemedToken, ThemeRegistration } from 'shiki';
import type { DiffLine } from '@/lib/diff';

/** Larger files show as plain text: highlighting them would stall the page. */
const MAX_CHARS = 300_000;

export function languageFor(path: string, known: Record<string, unknown>): string | null {
	const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
	const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
	if (extension in known) return extension;
	if (name.startsWith('dockerfile')) return 'dockerfile';
	return null;
}

const syntax = (name: string) => `var(--syntax-${name})`;

/** Every token is painted with a `--syntax-*` variable, so a block follows the theme without being highlighted again. */
const THEME: ThemeRegistration = {
	name: 'aura',
	type: 'dark',
	colors: { 'editor.foreground': syntax('variable'), 'editor.background': 'var(--bg-app)' },
	tokenColors: [
		{ scope: ['comment', 'punctuation.definition.comment', 'string.comment'], settings: { foreground: syntax('comment') } },
		{ scope: ['punctuation', 'meta.brace', 'meta.delimiter'], settings: { foreground: syntax('punctuation') } },
		{ scope: ['keyword.operator', 'punctuation.accessor'], settings: { foreground: syntax('operator') } },
		{
			scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.logical.python', 'punctuation.definition.template-expression', 'punctuation.section.embedded'],
			settings: { foreground: syntax('keyword') },
		},
		{ scope: ['string', 'punctuation.definition.string', 'string punctuation.section.embedded source', 'markup.inline.raw', 'markup.inserted'], settings: { foreground: syntax('string') } },
		{ scope: ['constant', 'constant.numeric', 'constant.language', 'constant.character', 'variable.language', 'support.constant', 'markup.deleted'], settings: { foreground: syntax('number') } },
		{ scope: ['entity.name.function', 'support.function', 'meta.function-call.generic', 'variable.function', 'markup.heading', 'punctuation.definition.heading', 'entity.name.section', 'markup.underline.link'], settings: { foreground: syntax('function') } },
		{
			scope: ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'entity.other.inherited-class', 'support.type', 'support.class', 'storage.type.primitive', 'support.type.primitive', 'support.type.builtin'],
			settings: { foreground: syntax('type') },
		},
		{ scope: ['entity.name.tag', 'support.class.component'], settings: { foreground: syntax('tag') } },
		{ scope: ['entity.other.attribute-name'], settings: { foreground: syntax('attribute') } },
		{ scope: ['variable.other.property', 'variable.other.object.property', 'meta.object-literal.key', 'support.type.property-name', 'support.variable.property'], settings: { foreground: syntax('property') } },
		{ scope: ['variable', 'variable.parameter', 'meta.template.expression', 'meta.embedded'], settings: { foreground: syntax('variable') } },
		{ scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
		{ scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
	],
};

/** Null when the file is too large or its language unknown. Shiki and each grammar load on first use. */
export async function highlight(code: string, path: string): Promise<ThemedToken[][] | null> {
	if (code.length > MAX_CHARS) return null;
	const { bundledLanguages, codeToTokens } = await import('shiki');
	const lang = languageFor(path, bundledLanguages);
	if (!lang) return null;
	const { tokens } = await codeToTokens(code, { lang: lang as keyof typeof bundledLanguages, theme: THEME });
	return tokens;
}

/** A small hash for a text whose colours are cached: 53 bits (cyrb53) plus the length, so entries in view practically never collide. */
export function hashText(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

type CodeDiffLine = Exclude<DiffLine, { kind: 'hunk' }>;

type IndexedLine = { line: CodeDiffLine; index: number };

async function highlightHunk(lines: IndexedLine[], path: string): Promise<Array<readonly [number, ThemedToken[] | null]> | null> {
	const before: string[] = [];
	const after: string[] = [];
	const beforeRows = new Map<number, number>();
	const afterRows = new Map<number, number>();
	const removals = lines.some(({ line }) => line.kind === 'remove');
	for (const { line, index } of lines) {
		if (removals && line.kind !== 'add') {
			beforeRows.set(index, before.length);
			before.push(line.text);
		}
		if (line.kind !== 'remove') {
			afterRows.set(index, after.length);
			after.push(line.text);
		}
	}
	const [beforeTokens, afterTokens] = await Promise.all([
		before.length ? highlight(before.join('\n'), path) : null,
		after.length ? highlight(after.join('\n'), path) : null,
	]);
	if (!beforeTokens && !afterTokens) return null;
	return lines.map(({ line, index }) => {
		if (line.kind === 'remove') return [index, beforeTokens?.[beforeRows.get(index) ?? -1] ?? null] as const;
		return [index, afterTokens?.[afterRows.get(index) ?? -1] ?? beforeTokens?.[beforeRows.get(index) ?? -1] ?? null] as const;
	});
}

/** Colours each visible line from the side of the diff it belongs to. Hunks are highlighted separately: their omitted context can hold a comment or string delimiter, so tokenizer state must not leak across them. */
export async function highlightDiff(lines: DiffLine[], path: string): Promise<Array<ThemedToken[] | null> | null> {
	const visibleChars = lines.reduce((sum, line) => (line.kind === 'hunk' ? sum : sum + line.text.length + 1), 0);
	if (visibleChars > MAX_CHARS) return null;
	const hunks: IndexedLine[][] = [];
	let current: IndexedLine[] = [];
	lines.forEach((line, index) => {
		if (line.kind === 'hunk') {
			if (current.length) hunks.push(current);
			current = [];
			return;
		}
		current.push({ line, index });
	});
	if (current.length) hunks.push(current);
	const rows: Array<ThemedToken[] | null> = Array(lines.length).fill(null);
	let highlighted = false;
	for (const hunk of hunks) {
		const tokens = await highlightHunk(hunk, path);
		if (!tokens) continue;
		highlighted = true;
		for (const [index, lineTokens] of tokens) rows[index] = lineTokens;
	}
	return highlighted ? rows : null;
}
