import type { LucideIcon } from 'lucide-react';
import { AppWindow, Braces, FileText, Image, Package, Sheet } from 'lucide-react';

/*
 * What kind of thing an artifact is, for the Artifacts page: apps (pages the
 * agent drew, and any other HTML file) first, as the ones you come back to
 * and use, then documents, images, data and code.
 */

export type Category = 'app' | 'document' | 'image' | 'data' | 'code' | 'other';

export const CATEGORIES: Array<{ key: Category; label: string; one: string; icon: LucideIcon; tone: string; test: RegExp }> = [
	{ key: 'app', label: 'Apps', one: 'App', icon: AppWindow, tone: 'text-(--data-2)', test: /\.html?$/i },
	{ key: 'document', label: 'Documents', one: 'Document', icon: FileText, tone: 'text-(--data-1)', test: /\.(md|markdown|txt|log|pdf|rtf|docx?)$/i },
	{ key: 'image', label: 'Images', one: 'Image', icon: Image, tone: 'text-(--data-5)', test: /\.(png|jpe?g|gif|webp|svg|avif)$/i },
	{ key: 'data', label: 'Data', one: 'Data', icon: Sheet, tone: 'text-(--data-4)', test: /\.(csv|tsv|json|jsonl|ya?ml|xml|xlsx?|parquet|sqlite|db)$/i },
	{ key: 'code', label: 'Code', one: 'Code', icon: Braces, tone: 'text-(--data-3)', test: /\.([cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|cs|php|sh|sql|css|scss|diff|patch|toml|ini)$/i },
	{ key: 'other', label: 'Other', one: 'File', icon: Package, tone: 'text-(--text-3)', test: /$^/ },
];

export function categoryOf(path: string): Category {
	return CATEGORIES.find((category) => category.test.test(path))?.key ?? 'other';
}

export const categoryInfo = (key: Category) => CATEGORIES.find((category) => category.key === key) ?? CATEGORIES[CATEGORIES.length - 1];

export const nameOf = (path: string) => path.split('/').pop() ?? path;
export const extensionOf = (path: string) => (nameOf(path).includes('.') ? (nameOf(path).split('.').pop()?.toUpperCase() ?? 'FILE') : 'FILE');

/** Whether a file reads as text, so a card can show its first lines and the viewer its source. */
export const isText = (path: string) => /\.(md|markdown|txt|log|csv|tsv|json|jsonl|ya?ml|xml|html?|[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|cs|php|sh|sql|css|scss|diff|patch|toml|ini)$/i.test(path);

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/**
 * A folder picked from disk as one .zip named for it, so a skill's folder (SKILL.md with its scripts beside it)
 * can be added and installed whole: Artifacts holds files, not folders. Paths inside keep the folder's own name
 * at the top, as zipping the folder by hand does; `skill` says whether it holds a SKILL.md to install.
 */
export async function zipFolder(files: File[]): Promise<{ file: File; skill: boolean }> {
	const { zipSync } = await import('fflate');
	const entries: Record<string, Uint8Array> = {};
	for (const file of files) {
		const path = file.webkitRelativePath || file.name;
		// Hidden files and folders (.git, .DS_Store) are not part of a skill.
		if (path.split('/').some((part) => part.startsWith('.'))) continue;
		entries[path] = new Uint8Array(await file.arrayBuffer());
	}
	const paths = Object.keys(entries);
	const top = paths[0]?.includes('/') ? paths[0].split('/')[0] : 'folder';
	const zipped = zipSync(entries);
	return {
		file: new File([zipped], `${top}.zip`, { type: 'application/zip' }),
		skill: paths.some((path) => path === 'SKILL.md' || path.endsWith('/SKILL.md')),
	};
}
