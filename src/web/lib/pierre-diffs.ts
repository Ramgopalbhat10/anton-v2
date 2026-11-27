import { type DiffsTheme, type FileDiffMetadata, parsePatchFiles, registerCustomTheme } from '@pierre/diffs';
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
import { createElement, Fragment, type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
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
	height: 28px;
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

/** Reads the single-line text at a 1-based line number on either side of a `FileDiffMetadata`. */
export function getLineTextFromDiff(fileDiff: FileDiffMetadata, side: 'deletions' | 'additions', lineNumber: number): string | null {
	if (lineNumber <= 0) return null;
	if (!fileDiff.isPartial) {
		const raw = (side === 'deletions' ? fileDiff.deletionLines : fileDiff.additionLines)[lineNumber - 1];
		return raw === undefined ? null : raw.replace(/\r?\n$/, '');
	}
	for (const hunk of fileDiff.hunks) {
		let delLine = hunk.deletionStart;
		let addLine = hunk.additionStart;
		for (const content of hunk.hunkContent) {
			if (content.type === 'context') {
				if (side === 'deletions' && lineNumber >= delLine && lineNumber < delLine + content.lines) {
					const raw = fileDiff.deletionLines[content.deletionLineIndex + (lineNumber - delLine)];
					return raw === undefined ? null : raw.replace(/\r?\n$/, '');
				}
				if (side === 'additions' && lineNumber >= addLine && lineNumber < addLine + content.lines) {
					const raw = fileDiff.additionLines[content.additionLineIndex + (lineNumber - addLine)];
					return raw === undefined ? null : raw.replace(/\r?\n$/, '');
				}
				delLine += content.lines;
				addLine += content.lines;
			} else {
				if (side === 'deletions' && lineNumber >= delLine && lineNumber < delLine + content.deletions) {
					const raw = fileDiff.deletionLines[content.deletionLineIndex + (lineNumber - delLine)];
					return raw === undefined ? null : raw.replace(/\r?\n$/, '');
				}
				if (side === 'additions' && lineNumber >= addLine && lineNumber < addLine + content.additions) {
					const raw = fileDiff.additionLines[content.additionLineIndex + (lineNumber - addLine)];
					return raw === undefined ? null : raw.replace(/\r?\n$/, '');
				}
				delLine += content.deletions;
				addLine += content.additions;
			}
		}
	}
	return null;
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
