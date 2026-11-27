import type { RegisteredHighlighter, Theme, ThemedToken } from '@pierre/highlights/core';
import type { DiffLine } from '@/lib/diff';

/** Larger files show as plain text: highlighting them would stall the page. */
const MAX_CHARS = 300_000;
const MAX_LINE_CHARS = 4_000;
const PLAIN_LANGS = new Set(['plain', 'plaintext', 'text', 'txt']);

export function languageFor(path: string, known: Record<string, unknown> | ((lang: string) => boolean)): string | null {
	const has = typeof known === 'function' ? known : (lang: string) => lang in known;
	const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
	const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
	if (has(extension)) return extension;
	if (name.startsWith('dockerfile')) return 'dockerfile';
	return null;
}

/**
 * Every token is painted with a `--syntax-*` variable, so code blocks and diffs
 * follow Aura's dark/light theme without being tokenized again.
 */
export function createAuraZedTheme(appearance: 'dark' | 'light' = 'dark'): Theme {
	return {
		name: appearance === 'light' ? 'aura-light' : 'aura-dark',
		appearance,
		cssVariables: {
			prefix: '--syntax-',
			defaults: { foreground: 'var(--syntax-variable)', background: 'var(--bg-surface)' },
		},
		style: {
			'editor.foreground': 'variable',
			syntax: {
				comment: 'comment',
				punctuation: 'punctuation',
				'punctuation.special': 'keyword',
				operator: 'operator',
				'keyword.operator': 'operator',
				keyword: 'keyword',
				preproc: 'keyword',
				string: 'string',
				'text.literal': 'string',
				'diff.plus': 'string',
				'diff.minus': 'number',
				number: 'number',
				boolean: 'number',
				constant: 'number',
				variant: 'number',
				'variable.special': 'number',
				function: 'function',
				title: 'function',
				link_text: 'function',
				link_uri: 'function',
				type: 'type',
				constructor: 'type',
				namespace: 'type',
				enum: 'type',
				tag: 'tag',
				selector: 'tag',
				attribute: 'attribute',
				label: 'attribute',
				property: 'property',
				variable: 'variable',
				embedded: 'variable',
				'text.jsx': 'variable',
				primary: 'variable',
				predictive: 'comment',
				hint: 'comment',
				emphasis: { color: 'variable', font_style: 'italic' },
				'emphasis.strong': { color: 'variable', font_weight: 700 },
				'emphasis.strong.italic': { color: 'variable', font_style: 'italic', font_weight: 700 },
				'markup.strikethrough': 'comment',
			},
		},
	};
}

const AURA_ZED_THEME = createAuraZedTheme('dark');

type HighlightState = {
	highlighter: RegisteredHighlighter;
	isSupportedLanguage: (lang: string) => boolean;
};

let loader: Promise<HighlightState> | undefined;

function loadHighlighter(): Promise<HighlightState> {
	return (loader ??= Promise.all([import('@pierre/highlights/core'), import('@pierre/highlights/langs')])
		.then(async ([{ createHighlighter, isSupportedLanguage }, { langs }]) => ({
			highlighter: await createHighlighter({ langs, themes: [AURA_ZED_THEME] }),
			isSupportedLanguage,
		}))
		.catch((error) => {
			loader = undefined;
			throw error;
		}));
}

/** Null when the file is too large or its language unknown. Highlights and its lexers load on first use. */
export async function highlight(code: string, path: string): Promise<ThemedToken[][] | null> {
	if (code.length > MAX_CHARS) return null;
	const { highlighter, isSupportedLanguage } = await loadHighlighter();
	const lang = languageFor(path, (candidate) => !PLAIN_LANGS.has(candidate) && isSupportedLanguage(candidate));
	if (!lang) return null;
	const { tokens } = highlighter.codeToTokens(code, {
		lang,
		theme: AURA_ZED_THEME.name,
		tokenizeMaxLineLength: MAX_LINE_CHARS,
	});
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
