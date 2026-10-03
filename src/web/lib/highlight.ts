import type { ThemedToken } from 'shiki';

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

/**
 * Colored tokens for each line, or null when the file is too large or its
 * language unknown. Shiki and each grammar load only when first needed.
 */
export async function highlight(code: string, path: string): Promise<ThemedToken[][] | null> {
	if (code.length > MAX_CHARS) return null;
	const { bundledLanguages, codeToTokens } = await import('shiki');
	const lang = languageFor(path, bundledLanguages);
	if (!lang) return null;
	const { tokens } = await codeToTokens(code, { lang: lang as keyof typeof bundledLanguages, theme: 'github-dark-default' });
	return tokens;
}
