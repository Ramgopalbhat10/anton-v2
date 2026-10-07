import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees';
import { createContext, type ReactNode, useContext, useId } from 'react';

const resolver = createFileTreeIconResolver({ set: 'standard', colored: true });
const sprite = getBuiltInSpriteSheet('standard');
const SpriteId = createContext('');

// Pierre's semantic dark palette. Its built-in styles live inside the tree's
// shadow root, so our standalone sprite icons need the same token colors here.
const COLOR_GROUPS: Array<[string, string[]]> = [
	['#ff6762', ['npm', 'postcss', 'ruby', 'svelte', 'yml']],
	['#d5512f', ['git']],
	['#ffa359', ['claude', 'html', 'json', 'rust', 'svg', 'swift', 'zig', 'zip']],
	['#ffd452', ['babel', 'browserslist', 'javascript']],
	['#5ecc71', ['bash', 'markdown', 'svgo', 'vue']],
	['#64d1db', ['mcp', 'prettier', 'table']],
	['#68cdf2', ['go', 'oxc', 'react', 'tailwind', 'webpack']],
	['#69b1ff', ['biome', 'c', 'cpp', 'docker', 'python', 'typescript', 'vscode']],
	['#9d6afb', ['bootstrap', 'css', 'eslint', 'terraform', 'wasm']],
	['#d568ea', ['astro', 'database', 'vite']],
	['#ff678d', ['graphql', 'image', 'sass']],
	['#79697b', ['bun']],
];
const colors = Object.fromEntries(COLOR_GROUPS.flatMap(([color, tokens]) => tokens.map((token) => [token, color])));

/** Pierre's built-in symbols, scoped so separate viewers never share SVG IDs. */
export function FileIcons({ children }: { children: ReactNode }) {
	const id = useId().replace(/:/g, '') + '-';
	return (
		<SpriteId.Provider value={id}>
			<div className="absolute size-0 overflow-hidden" aria-hidden dangerouslySetInnerHTML={{ __html: sprite.replaceAll('id="', `id="${id}`) }} />
			{children}
		</SpriteId.Provider>
	);
}

export function FileIcon({ path }: { path: string }) {
	const id = useContext(SpriteId);
	const icon = resolver.resolveIcon('file-tree-icon-file', path);
	return (
		<svg
			aria-hidden
			width="14"
			height="14"
			data-icon-token={icon.token}
			style={{ color: colors[icon.token ?? ''] ?? 'var(--icon-secondary)' }}
			viewBox={icon.viewBox ?? '0 0 16 16'}
			className="shrink-0 text-(--icon-secondary)"
		>
			<use href={`#${id}${icon.name}`} />
		</svg>
	);
}
