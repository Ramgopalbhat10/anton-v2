import type { ThemedToken, ThemeRegistration } from 'shiki';

/** Larger files show as plain text: highlighting them would stall the page. */
const MAX_CHARS = 300_000;

/** Shiki's language for a path, by extension or by a few well-known file names. */
export function languageFor(path: string, known: Record<string, unknown>): string | null {
	const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
	const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
	if (extension in known) return extension;
	if (name.startsWith('dockerfile')) return 'dockerfile';
	return null;
}

const syntax = (name: string) => `var(--syntax-${name})`;

/**
 * Code in the page's own syntax colours: every token is painted with a `--syntax-*` variable
 * (styles/aura-tokens.css), so a block follows the light and dark themes without being highlighted again.
 */
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

/**
 * Colored tokens for each line, or null when the file is too large or its
 * language unknown. Shiki and each grammar load only when first needed.
 */
export async function highlight(code: string, path: string): Promise<ThemedToken[][] | null> {
	if (code.length > MAX_CHARS) return null;
	const { bundledLanguages, codeToTokens } = await import('shiki');
	const lang = languageFor(path, bundledLanguages);
	if (!lang) return null;
	const { tokens } = await codeToTokens(code, { lang: lang as keyof typeof bundledLanguages, theme: THEME });
	return tokens;
}
