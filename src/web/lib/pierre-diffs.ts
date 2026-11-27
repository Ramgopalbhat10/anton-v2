import { type DiffsTheme, type FileDiffContentsLoader, type FileDiffMetadata, parsePatchFiles, registerCustomTheme } from '@pierre/diffs';
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
import { createElement, Fragment, type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import type { DiffFileContents } from '@/lib/api/workspace';
import type { FileDiff } from '@/lib/diff';
import { createAuraZedTheme, hashText } from '@/lib/highlight';

export const AURA_DIFF_THEMES = { dark: 'aura-dark', light: 'aura-light' } as const;

let themesRegistered = false;

function makeDiffsTheme(appearance: 'dark' | 'light'): DiffsTheme {
	return {
		name: appearance === 'light' ? 'aura-light' : 'aura-dark',
		type: appearance,
		fg: 'var(--syntax-variable)',
		bg: 'var(--bg-surface)',
		colors: {
			'editor.foreground': 'var(--syntax-variable)',
			'editor.background': 'var(--bg-surface)',
		},
		zed: createAuraZedTheme(appearance),
	};
}

/** Registers Aura dark and light Zed-backed themes once on the main thread before workers initialize. */
export function ensureAuraDiffThemes(): void {
	if (themesRegistered) return;
	themesRegistered = true;
	for (const appearance of ['dark', 'light'] as const) {
		const theme = makeDiffsTheme(appearance);
		registerCustomTheme(theme.name, () => Promise.resolve(theme), 'diffs');
	}
}

export const ANTON_DIFF_UNSAFE_CSS = `
[data-separator='line-info'] {
	font-size: var(--fs-11);
	color: var(--text-3);
	border-block: 1px solid var(--line);
}
[data-separator='line-info'][data-separator-first] {
	border-top: 0;
}
[data-separator='line-info'][data-separator-last] {
	border-bottom: 0;
}
[data-separator='line-info'] [data-separator-content],
[data-separator='line-info'] [data-separator-wrapper] {
	border-radius: 0;
}
[data-separator='line-info'] [data-expand-button] {
	border-radius: 0;
	color: var(--text-3);
	border-right-color: var(--line);
}
[data-separator='line-info'] [data-expand-button]:hover,
[data-separator='line-info'][data-expand-index] [data-separator-content]:hover {
	color: var(--text);
	background-color: var(--bg-hover);
	text-decoration: none;
}
[data-diff-type='split'] [data-additions] {
	border-left: 1px solid var(--line);
}
[data-diff-type='split'] [data-deletions] {
	border-right: 0;
}
[data-gutter-utility-slot] {
	align-items: center;
}
`;

export type DiffViewPrefs = {
	diffStyle: 'split' | 'unified';
	diffIndicators: 'bars' | 'classic' | 'none';
	lineDiffType: 'word-alt' | 'word' | 'char' | 'none';
	disableBackground: boolean;
	overflow: 'scroll' | 'wrap';
	disableLineNumbers: boolean;
};

const PREFS_KEY = 'anton.diff.prefs';

export const DEFAULT_DIFF_PREFS: DiffViewPrefs = {
	diffStyle: 'split',
	diffIndicators: 'bars',
	lineDiffType: 'word-alt',
	disableBackground: false,
	overflow: 'scroll',
	disableLineNumbers: false,
};

function sanitizePrefs(raw: unknown): DiffViewPrefs {
	if (!raw || typeof raw !== 'object') return DEFAULT_DIFF_PREFS;
	const value = raw as Partial<DiffViewPrefs>;
	return {
		diffStyle: value.diffStyle === 'unified' || value.diffStyle === 'split' ? value.diffStyle : DEFAULT_DIFF_PREFS.diffStyle,
		diffIndicators:
			value.diffIndicators === 'bars' || value.diffIndicators === 'classic' || value.diffIndicators === 'none'
				? value.diffIndicators
				: DEFAULT_DIFF_PREFS.diffIndicators,
		lineDiffType:
			value.lineDiffType === 'word-alt' ||
			value.lineDiffType === 'word' ||
			value.lineDiffType === 'char' ||
			value.lineDiffType === 'none'
				? value.lineDiffType
				: DEFAULT_DIFF_PREFS.lineDiffType,
		disableBackground: typeof value.disableBackground === 'boolean' ? value.disableBackground : DEFAULT_DIFF_PREFS.disableBackground,
		overflow: value.overflow === 'wrap' || value.overflow === 'scroll' ? value.overflow : DEFAULT_DIFF_PREFS.overflow,
		disableLineNumbers: typeof value.disableLineNumbers === 'boolean' ? value.disableLineNumbers : DEFAULT_DIFF_PREFS.disableLineNumbers,
	};
}

function readPrefs(): DiffViewPrefs {
	try {
		const raw = localStorage.getItem(PREFS_KEY);
		return raw === null ? DEFAULT_DIFF_PREFS : sanitizePrefs(JSON.parse(raw));
	} catch {
		return DEFAULT_DIFF_PREFS;
	}
}

let currentPrefs: DiffViewPrefs = readPrefs();
const prefsListeners = new Set<() => void>();

export function getDiffViewPrefs(): DiffViewPrefs {
	return currentPrefs;
}

export function setDiffViewPrefs(patch: Partial<DiffViewPrefs>): void {
	currentPrefs = sanitizePrefs({ ...currentPrefs, ...patch });
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(currentPrefs));
	} catch {
		// Persistence is optional when storage is restricted.
	}
	for (const listener of prefsListeners) listener();
}

export function useDiffViewPrefs(): DiffViewPrefs {
	return useSyncExternalStore(
		(listener) => {
			prefsListeners.add(listener);
			return () => {
				prefsListeners.delete(listener);
			};
		},
		() => currentPrefs,
		() => DEFAULT_DIFF_PREFS,
	);
}

const MAX_DIFF_CACHE = 500;
const parsedDiffCache = new Map<string, FileDiffMetadata>();

/**
 * Reuses the exact `FileDiffMetadata` reference when a file's patch text has not changed
 * across live polling updates, keeping expanded state and worker caches intact.
 */
export function getCachedFileDiffMetadata(file: Pick<FileDiff, 'path'>, rawPatch: string): FileDiffMetadata | null {
	if (!rawPatch.trim()) return null;
	const hash = hashText(rawPatch);
	const key = `${file.path}\0${rawPatch.length}\0${hash}`;
	const existing = parsedDiffCache.get(key);
	if (existing) {
		// Refresh insertion order for simple LRU eviction.
		parsedDiffCache.delete(key);
		parsedDiffCache.set(key, existing);
		return existing;
	}
	const parsed = parsePatchFiles(rawPatch, { cacheKeyPrefix: `anton:${file.path}:${hash}` });
	const metadata = parsed[0]?.files[0] ?? null;
	if (!metadata) return null;
	if (parsedDiffCache.size >= MAX_DIFF_CACHE) {
		const oldest = parsedDiffCache.keys().next().value;
		if (oldest !== undefined) parsedDiffCache.delete(oldest);
	}
	parsedDiffCache.set(key, metadata);
	return metadata;
}

export const normalizeDiffLine = (text: string): string => text.replace(/\r?\n?$/, '');

/** Reads the single-line text at a 1-based line number on either side of a `FileDiffMetadata`. */
export function getLineTextFromDiff(fileDiff: FileDiffMetadata, side: 'deletions' | 'additions', lineNumber: number): string | null {
	if (lineNumber <= 0) return null;
	if (!fileDiff.isPartial) {
		const raw = (side === 'deletions' ? fileDiff.deletionLines : fileDiff.additionLines)[lineNumber - 1];
		return raw === undefined ? null : normalizeDiffLine(raw);
	}
	for (const hunk of fileDiff.hunks) {
		let delLine = hunk.deletionStart;
		let addLine = hunk.additionStart;
		for (const content of hunk.hunkContent) {
			if (content.type === 'context') {
				if (side === 'deletions' && lineNumber >= delLine && lineNumber < delLine + content.lines) {
					const raw = fileDiff.deletionLines[content.deletionLineIndex + (lineNumber - delLine)];
					return raw === undefined ? null : normalizeDiffLine(raw);
				}
				if (side === 'additions' && lineNumber >= addLine && lineNumber < addLine + content.lines) {
					const raw = fileDiff.additionLines[content.additionLineIndex + (lineNumber - addLine)];
					return raw === undefined ? null : normalizeDiffLine(raw);
				}
				delLine += content.lines;
				addLine += content.lines;
			} else {
				if (side === 'deletions' && lineNumber >= delLine && lineNumber < delLine + content.deletions) {
					const raw = fileDiff.deletionLines[content.deletionLineIndex + (lineNumber - delLine)];
					return raw === undefined ? null : normalizeDiffLine(raw);
				}
				if (side === 'additions' && lineNumber >= addLine && lineNumber < addLine + content.additions) {
					const raw = fileDiff.additionLines[content.additionLineIndex + (lineNumber - addLine)];
					return raw === undefined ? null : normalizeDiffLine(raw);
				}
				delLine += content.deletions;
				addLine += content.additions;
			}
		}
	}
	return null;
}

/** Checks that fetched old/new files still match the displayed patch hunks before hydrating collapsed context. */
export function filesMatchDiffMetadata(fileDiff: FileDiffMetadata, oldText: string, newText: string): boolean {
	const oldLines = oldText === '' ? [] : oldText.split(/(?<=\n)/);
	const newLines = newText === '' ? [] : newText.split(/(?<=\n)/);
	let delCursor = 0;
	let addCursor = 0;

	for (const hunk of fileDiff.hunks) {
		const delStart = hunk.deletionCount === 0 ? hunk.deletionStart : Math.max(hunk.deletionStart - 1, 0);
		const addStart = hunk.additionCount === 0 ? hunk.additionStart : Math.max(hunk.additionStart - 1, 0);
		const delGap = delStart - delCursor;
		const addGap = addStart - addCursor;
		if (delGap < 0 || delGap !== addGap) return false;
		if (delCursor + delGap > oldLines.length || addCursor + addGap > newLines.length) return false;
		for (let i = 0; i < delGap; i++) {
			if (normalizeDiffLine(oldLines[delCursor + i]!) !== normalizeDiffLine(newLines[addCursor + i]!)) return false;
		}
		delCursor = delStart;
		addCursor = addStart;

		for (const content of hunk.hunkContent) {
			if (content.type === 'context') {
				if (delCursor + content.lines > oldLines.length || addCursor + content.lines > newLines.length) return false;
				for (let i = 0; i < content.lines; i++) {
					const expectedDel = fileDiff.deletionLines[content.deletionLineIndex + i];
					const expectedAdd = fileDiff.additionLines[content.additionLineIndex + i];
					if (expectedDel === undefined || expectedAdd === undefined) return false;
					if (normalizeDiffLine(oldLines[delCursor + i]!) !== normalizeDiffLine(expectedDel)) return false;
					if (normalizeDiffLine(newLines[addCursor + i]!) !== normalizeDiffLine(expectedAdd)) return false;
				}
				delCursor += content.lines;
				addCursor += content.lines;
			} else {
				if (delCursor + content.deletions > oldLines.length || addCursor + content.additions > newLines.length) return false;
				for (let i = 0; i < content.deletions; i++) {
					const expectedDel = fileDiff.deletionLines[content.deletionLineIndex + i];
					if (expectedDel === undefined) return false;
					if (normalizeDiffLine(oldLines[delCursor + i]!) !== normalizeDiffLine(expectedDel)) return false;
				}
				for (let i = 0; i < content.additions; i++) {
					const expectedAdd = fileDiff.additionLines[content.additionLineIndex + i];
					if (expectedAdd === undefined) return false;
					if (normalizeDiffLine(newLines[addCursor + i]!) !== normalizeDiffLine(expectedAdd)) return false;
				}
				delCursor += content.deletions;
				addCursor += content.additions;
			}
		}
	}

	const delTail = oldLines.length - delCursor;
	const addTail = newLines.length - addCursor;
	if (delTail !== addTail) return false;
	for (let i = 0; i < delTail; i++) {
		if (normalizeDiffLine(oldLines[delCursor + i]!) !== normalizeDiffLine(newLines[addCursor + i]!)) return false;
	}
	return true;
}

/** Adapts Anton's `{ oldText, newText }` endpoint to `@pierre/diffs`'s `loadDiffFiles` loader. */
export function createDiffFilesLoader(
	fetchFiles: (input: { path: string; prevPath?: string }) => Promise<DiffFileContents>,
	options?: { onStale?: () => void },
): FileDiffContentsLoader {
	return async (fileDiff) => {
		const { oldText, newText } = await fetchFiles({ path: fileDiff.name, prevPath: fileDiff.prevName });
		if (fileDiff.type === 'rename-pure') {
			if (newText === null) throw new Error(`Could not load full file contents for ${fileDiff.name}`);
			return {
				oldFile: null,
				newFile: {
					name: fileDiff.name,
					contents: newText,
					cacheKey: `anton-file:${fileDiff.name}:${newText.length}:${hashText(newText)}`,
				},
			};
		}
		if (oldText === null || newText === null) {
			throw new Error(`Could not load full file contents for ${fileDiff.name}`);
		}
		if (!filesMatchDiffMetadata(fileDiff, oldText, newText)) {
			options?.onStale?.();
			throw new Error(options?.onStale ? 'File changed since this diff loaded. Refreshing diff…' : 'File changed since this diff loaded; refresh to expand context.');
		}
		const oldName = fileDiff.prevName ?? fileDiff.name;
		return {
			oldFile: {
				name: oldName,
				contents: oldText,
				cacheKey: `anton-file:${oldName}:${oldText.length}:${hashText(oldText)}`,
			},
			newFile: {
				name: fileDiff.name,
				contents: newText,
				cacheKey: `anton-file:${fileDiff.name}:${newText.length}:${hashText(newText)}`,
			},
		};
	};
}

/** Maps a hovered diff line to a canonical review comment target (`old` only for removed lines or deleted files). */
/** The range's lines joined with newlines, or null when any line in it is not present in the diff. */
export function getRangeTextFromDiff(fileDiff: FileDiffMetadata, side: 'deletions' | 'additions', start: number, end: number): string | null {
	const lines: string[] = [];
	for (let line = start; line <= end; line++) {
		const text = getLineTextFromDiff(fileDiff, side, line);
		if (text === null) return null;
		lines.push(text);
	}
	return lines.join('\n');
}

export function resolveCommentTarget(
	fileDiff: FileDiffMetadata,
	side: 'deletions' | 'additions',
	lineNumber: number,
): { side: 'old' | 'new'; line: number } {
	if (side === 'additions') return { side: 'new', line: lineNumber };
	if (fileDiff.type === 'deleted') return { side: 'old', line: lineNumber };
	let delta = 0;
	for (const hunk of fileDiff.hunks) {
		if (!fileDiff.isPartial && lineNumber < hunk.deletionStart) {
			return { side: 'new', line: lineNumber + (hunk.additionStart - hunk.deletionStart) };
		}
		let delLine = hunk.deletionStart;
		let addLine = hunk.additionStart;
		for (const content of hunk.hunkContent) {
			if (content.type === 'context') {
				if (lineNumber >= delLine && lineNumber < delLine + content.lines) {
					return { side: 'new', line: addLine + (lineNumber - delLine) };
				}
				delLine += content.lines;
				addLine += content.lines;
			} else {
				if (lineNumber >= delLine && lineNumber < delLine + content.deletions) {
					return { side: 'old', line: lineNumber };
				}
				delLine += content.deletions;
				addLine += content.additions;
			}
		}
		delta = addLine - delLine;
	}
	if (!fileDiff.isPartial) return { side: 'new', line: lineNumber + delta };
	return { side: 'old', line: lineNumber };
}

export type DiffCommentTarget = {
	side: 'deletions' | 'additions';
	lineNumber: number;
};

/** Ordered list of visible diff lines that can receive inline review comments. */
export function getDiffCommentTargets(fileDiff: FileDiffMetadata): DiffCommentTarget[] {
	const targets: DiffCommentTarget[] = [];
	for (const hunk of fileDiff.hunks) {
		let delLine = hunk.deletionStart;
		let addLine = hunk.additionStart;
		for (const content of hunk.hunkContent) {
			if (content.type === 'context') {
				for (let offset = 0; offset < content.lines; offset++) {
					targets.push({ side: 'additions', lineNumber: addLine + offset });
				}
				delLine += content.lines;
				addLine += content.lines;
			} else {
				for (let offset = 0; offset < content.deletions; offset++) {
					targets.push({ side: 'deletions', lineNumber: delLine + offset });
				}
				for (let offset = 0; offset < content.additions; offset++) {
					targets.push({ side: 'additions', lineNumber: addLine + offset });
				}
				delLine += content.deletions;
				addLine += content.additions;
			}
		}
	}
	return targets;
}

function WorkerPoolOptionsSync({ lineDiffType }: { lineDiffType: DiffViewPrefs['lineDiffType'] }) {
	const workerPool = useWorkerPool();
	useEffect(() => {
		if (!workerPool) return;
		if (workerPool.getDiffRenderOptions().lineDiffType === lineDiffType) return;
		void workerPool.setRenderOptions({ lineDiffType });
	}, [workerPool, lineDiffType]);
	return null;
}

export function DiffWorkerProvider({ children }: { children: ReactNode }) {
	const prefs = useDiffViewPrefs();
	const [initialLineDiffType] = useState(() => prefs.lineDiffType);
	ensureAuraDiffThemes();

	if (typeof window === 'undefined' || typeof Worker === 'undefined') {
		return createElement(Fragment, null, children);
	}

	return createElement(WorkerPoolContextProvider, {
		poolOptions: {
			workerFactory: () => new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), { type: 'module' }),
			poolSize: 2,
			totalASTLRUCacheSize: 120,
		},
		highlighterOptions: {
			theme: AURA_DIFF_THEMES,
			preferredHighlighter: 'highlights',
			preferredDiffLib: '@pierre/patches',
			lineDiffType: initialLineDiffType,
			tokenizeMaxLineLength: 4_000,
		},
		children: createElement(Fragment, null, createElement(WorkerPoolOptionsSync, { lineDiffType: prefs.lineDiffType }), children),
	});
}
