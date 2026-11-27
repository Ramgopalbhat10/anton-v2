import type {
	FileDiff as PierreFileDiffClass,
	FileDiffContentsLoader,
	PostRenderPhase,
	SelectedLineRange,
	VirtualizedFileDiff as PierreVirtualizedFileDiffClass,
} from '@pierre/diffs';
import { type DiffLineAnnotation, FileDiff as PierreFileDiff, useVirtualizer, Virtualizer } from '@pierre/diffs/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, ExternalLink, MessageSquare, MoreHorizontal, Plus, SlidersHorizontal, Undo2, X } from '@/lib/icons';
import { Fragment, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Disclosure } from '@/components/kit/disclosure';
import { Segmented, SegmentedItem } from '@/components/kit/instrument';
import { FileIcon, FileIcons } from '@/components/marks/file-icons';
import { StatusChip } from '@/components/content/file-view';
import { ChangesArt } from '@/components/marks/illustrations';
import { Btn, DiffStat, EmptyState, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { FileDiff } from '@/lib/diff';
import {
	ANTON_DIFF_UNSAFE_CSS,
	AURA_DIFF_THEMES,
	type DiffCommentTarget,
	DiffWorkerProvider,
	getCachedFileDiffMetadata,
	getDiffCommentTargets,
	getLineTextFromDiff,
	normalizeDiffLine,
	resolveCommentTarget,
	setDiffViewPrefs,
	useDiffViewPrefs,
} from '@/lib/pierre-diffs';
import { type ReviewComment, useReviewComments } from '@/lib/review';
import { useTheme } from '@/lib/theme';
import { useElementSize } from '@/lib/use-element-size';
import { cn } from '@/lib/utils';
import { focusFile, ShowPanel } from '@/lib/workspace';

/** Below this diff pane width (px), split diffs fall back to stacked unified layout. */
const SPLIT_MIN_WIDTH = 720;
const TOOLBAR_COMPACT_WIDTH = 460;
const TOOLBAR_TIGHT_WIDTH = 380;
const STICKY_HEADER_HEIGHT = 32;

export function isDiffPaneNarrow(width: number): boolean {
	return width > 0 && width < SPLIT_MIN_WIDTH;
}

export function isDiffToolbarCompact(width: number): boolean {
	return width > 0 && width < TOOLBAR_COMPACT_WIDTH;
}

export function isDiffToolbarTight(width: number): boolean {
	return width > 0 && width < TOOLBAR_TIGHT_WIDTH;
}

/** Draft comments on one file of the diff; absent where the diff is read-only. */
export type Commenting = {
	comments: ReviewComment[];
	onAdd: (comment: ReviewComment) => void;
	onRemove: (comment: ReviewComment) => void;
};

type DraftAnnotationGroup = {
	comments: Array<{ comment: ReviewComment; outdated: boolean }>;
	composer?: { side: ReviewComment['side']; line: number };
};

function CommentCard({ comment, onRemove, outdated }: { comment: ReviewComment; onRemove: () => void; outdated?: boolean }) {
	return (
		<div className="in-pop my-1.5 mx-2 flex w-[min(480px,calc(100%-1rem))] items-start gap-2 border-l-2 border-l-(--accent) px-2.5 py-2 font-sans">
			<Icon icon={MessageSquare} size={12} className="mt-[3px] text-(--text-3)" />
			<div className="min-w-0 flex-1 text-small leading-[18px] whitespace-pre-wrap text-(--text)">
				{outdated ? <div className="text-(--text-3)">Line {comment.line} has changed since this comment</div> : null}
				{comment.text}
			</div>
			<IconBtn icon={X} size="xs" label="Delete comment" onClick={onRemove} />
		</div>
	);
}

function CommentForm({
	value,
	onChange,
	onSave,
	onCancel,
}: {
	value: string;
	onChange: (value: string) => void;
	onSave: (text: string) => void;
	onCancel: () => void;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		// Pierre adds the Shadow DOM annotation slot during layout effects, after React's autoFocus commit step.
		el.focus();
		if (document.activeElement === el) {
			el.closest('.in-pop')?.scrollIntoView?.({ block: 'nearest' });
			return;
		}
		let frame = 0;
		let attempts = 0;
		const retry = () => {
			const node = textareaRef.current;
			if (!node || attempts++ >= 20) return;
			if (document.activeElement !== node) node.focus();
			if (document.activeElement === node) {
				node.closest('.in-pop')?.scrollIntoView?.({ block: 'nearest' });
				return;
			}
			frame = requestAnimationFrame(retry);
		};
		frame = requestAnimationFrame(retry);
		return () => cancelAnimationFrame(frame);
	}, []);
	const save = () => (value.trim() ? onSave(value.trim()) : undefined);
	return (
		<div className="in-pop my-1.5 mx-2 flex w-[min(480px,calc(100%-1rem))] flex-col gap-2 border-l-2 border-l-(--accent) p-2 font-sans">
			<textarea
				ref={textareaRef}
				autoFocus
				rows={2}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						save();
					}
					if (event.key === 'Escape') {
						event.stopPropagation();
						onCancel();
					}
				}}
				placeholder="What should the agent change here?"
				aria-label="Comment"
				className="sg-field w-full resize-none px-2 py-1.5 text-small leading-[18px]"
			/>
			<div className="flex justify-end gap-1.5">
				<Btn size="xs" variant="ghost" onClick={onCancel}>
					Cancel
				</Btn>
				<Btn size="xs" variant="primary" onClick={save} disabled={!value.trim()}>
					Add comment
				</Btn>
			</div>
		</div>
	);
}

function diffText(file: FileDiff): string {
	if (file.patch) return file.patch;
	return file.lines
		.map((line) => (line.kind === 'hunk' ? `@@ ${line.text} @@` : `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`))
		.join('\n');
}

function findMountedLineElement(shadow: ShadowRoot, target: DiffCommentTarget, diffStyle: 'split' | 'unified'): HTMLElement | null {
	const el =
		diffStyle === 'split'
			? shadow.querySelector(`${target.side === 'deletions' ? '[data-deletions]' : '[data-additions]'} [data-line="${target.lineNumber}"]`)
			: (target.side === 'deletions'
					? shadow.querySelector(`[data-line="${target.lineNumber}"][data-line-type="change-deletion"]`)
					: shadow.querySelector(`[data-line="${target.lineNumber}"][data-line-type="change-addition"]`) ??
						shadow.querySelector(`[data-line="${target.lineNumber}"][data-line-type="context"]`)) ??
				shadow.querySelector(`[data-line="${target.lineNumber}"]`);
	return el instanceof HTMLElement ? el : null;
}

function DiffLines({
	file,
	commenting,
	narrow,
	loadDiffFiles,
}: {
	file: FileDiff;
	commenting?: Commenting;
	narrow: boolean;
	loadDiffFiles?: FileDiffContentsLoader;
}) {
	// The line being commented on and its unsaved text live here, so deleting another comment keeps the draft intact.
	const [draft, setDraft] = useState<{ side: ReviewComment['side']; line: number } | null>(null);
	const [draftText, setDraftText] = useState('');
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const diffContainerRef = useRef<HTMLDivElement>(null);
	const diffInstanceRef = useRef<PierreFileDiffClass<DraftAnnotationGroup> | null>(null);
	const pointerDownRef = useRef(false);
	const restoringFocusRef = useRef(false);
	const [focusedTargetIndex, setFocusedTargetIndex] = useState<number | null>(null);
	const [expandError, setExpandError] = useState<string | null>(null);
	const [hydrationRevision, setHydrationRevision] = useState(0);
	const partialHydrationRef = useRef<boolean | undefined>(undefined);
	const virtualizer = useVirtualizer();
	const theme = useTheme();
	const prefs = useDiffViewPrefs();
	const rawPatch = useMemo(() => diffText(file), [file]);
	useEffect(() => {
		setExpandError(null);
	}, [rawPatch]);
	const wrappedLoadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
		if (!loadDiffFiles) return undefined;
		return async (meta) => {
			setExpandError(null);
			try {
				return await loadDiffFiles(meta);
			} catch (error) {
				setExpandError(error instanceof Error && error.message ? error.message : 'Could not expand context.');
				throw error;
			}
		};
	}, [loadDiffFiles]);
	const fileDiff = useMemo(() => getCachedFileDiffMetadata(file, rawPatch), [file, rawPatch]);
	const effectiveDiffStyle: 'split' | 'unified' = prefs.diffStyle === 'split' && !narrow ? 'split' : 'unified';
	const hasCommenting = Boolean(commenting);
	const commentTargets = useMemo(() => (fileDiff && hasCommenting ? getDiffCommentTargets(fileDiff) : []), [fileDiff, hasCommenting, hydrationRevision]);
	const activeTarget = focusedTargetIndex !== null && commentTargets.length > 0 ? commentTargets[Math.min(focusedTargetIndex, commentTargets.length - 1)] : null;
	const activeSelection = useMemo<SelectedLineRange | null>(
		() => (activeTarget ? { start: activeTarget.lineNumber, end: activeTarget.lineNumber, side: activeTarget.side } : null),
		[activeTarget],
	);

	useEffect(() => () => {
		diffInstanceRef.current = null;
	}, []);

	const handlePostRender = useCallback(
		(_node: HTMLElement, instance: PierreFileDiffClass<DraftAnnotationGroup>, phase: PostRenderPhase) => {
			diffInstanceRef.current = phase === 'unmount' ? null : instance;
			if (phase === 'unmount') {
				partialHydrationRef.current = undefined;
				return;
			}
			const partial = instance.fileDiff?.isPartial;
			if (partialHydrationRef.current === true && partial === false) setHydrationRevision((revision) => revision + 1);
			partialHydrationRef.current = partial;
		},
		[],
	);

	const openDraft = useCallback((target: { side: ReviewComment['side']; line: number }) => {
		if (draftRef.current?.side === target.side && draftRef.current.line === target.line) return;
		setDraft(target);
		setDraftText('');
	}, []);

	const closeDraft = useCallback((restoreFocus = false) => {
		setDraft(null);
		setDraftText('');
		if (restoreFocus) {
			restoringFocusRef.current = true;
			diffContainerRef.current?.focus({ preventScroll: true });
			restoringFocusRef.current = false;
		}
	}, []);

	useEffect(() => {
		if (!activeTarget) return;
		if (virtualizer) {
			const onDone = () => {};
			virtualizer.scrollSpanIntoView({
				align: 'nearest',
				onDone,
				resolveSpan: () => {
					const host = diffContainerRef.current?.querySelector('diffs-container');
					if (!(host instanceof HTMLElement)) return undefined;
					let rawTop: number | undefined;
					let rawHeight: number | undefined;
					const lineEl = host.shadowRoot ? findMountedLineElement(host.shadowRoot, activeTarget, effectiveDiffStyle) : null;
					const lineRect = lineEl?.getBoundingClientRect();
					if (lineEl && lineRect && lineRect.height > 0) {
						rawTop = virtualizer.getOffsetInScrollContainer(lineEl);
						rawHeight = lineRect.height;
					} else {
						const inst = diffInstanceRef.current;
						if (inst && 'getLinePosition' in inst && typeof inst.getLinePosition === 'function') {
							const pos = (inst as PierreVirtualizedFileDiffClass<DraftAnnotationGroup>).getLinePosition(activeTarget.lineNumber, activeTarget.side);
							if (pos) {
								rawTop = virtualizer.getOffsetInScrollContainer(host) + pos.top;
								rawHeight = pos.height;
							}
						}
					}
					if (rawTop === undefined || rawHeight === undefined) return undefined;
					const top = Math.max(0, rawTop - STICKY_HEADER_HEIGHT);
					return { top, height: rawHeight + (rawTop - top) };
				},
			});
			return () => virtualizer.cancelScroll(onDone);
		}
		const shadow = diffContainerRef.current?.querySelector('diffs-container')?.shadowRoot;
		if (!shadow) return;
		findMountedLineElement(shadow, activeTarget, effectiveDiffStyle)?.scrollIntoView?.({ block: 'nearest' });
	}, [activeTarget, effectiveDiffStyle, virtualizer]);

	const options = useMemo(
		() => ({
			theme: AURA_DIFF_THEMES,
			themeType: theme,
			preferredHighlighter: 'highlights' as const,
			disableFileHeader: true,
			diffStyle: effectiveDiffStyle,
			diffIndicators: prefs.diffIndicators,
			lineDiffType: prefs.lineDiffType,
			disableBackground: prefs.disableBackground,
			disableLineNumbers: prefs.disableLineNumbers,
			overflow: prefs.overflow,
			hunkSeparators: 'line-info' as const,
			enableGutterUtility: hasCommenting,
			loadDiffFiles: wrappedLoadDiffFiles,
			tokenizeMaxLineLength: 4_000,
			unsafeCSS: ANTON_DIFF_UNSAFE_CSS,
			onPostRender: handlePostRender,
		}),
		[
			theme,
			effectiveDiffStyle,
			prefs.diffIndicators,
			prefs.lineDiffType,
			prefs.disableBackground,
			prefs.disableLineNumbers,
			prefs.overflow,
			hasCommenting,
			wrappedLoadDiffFiles,
			handlePostRender,
		],
	);

	const lineAnnotations = useMemo<DiffLineAnnotation<DraftAnnotationGroup>[]>(() => {
		if (!fileDiff || !commenting) return [];
		const fileAnnotationSide = fileDiff.type === 'deleted' ? 'deletions' : 'additions';
		const grouped = new Map<string, DiffLineAnnotation<DraftAnnotationGroup>>();
		const ensureGroup = (side: 'deletions' | 'additions', lineNumber: number) => {
			const key = `${side}:${lineNumber}`;
			let entry = grouped.get(key);
			if (!entry) {
				entry = { side, lineNumber, metadata: { comments: [] } };
				grouped.set(key, entry);
			}
			return entry;
		};
		for (const comment of commenting.comments) {
			const side = comment.side === 'old' ? 'deletions' : 'additions';
			const currentCode = getLineTextFromDiff(fileDiff, side, comment.line);
			const outdated = currentCode === null || normalizeDiffLine(currentCode) !== normalizeDiffLine(comment.code);
			const targetSide = outdated ? fileAnnotationSide : side;
			const targetLine = outdated ? 0 : comment.line;
			ensureGroup(targetSide, targetLine).metadata.comments.push({ comment, outdated });
		}
		if (draft) {
			const targetSide = draft.side === 'old' ? 'deletions' : 'additions';
			ensureGroup(targetSide, draft.line).metadata.composer = draft;
		}
		return [...grouped.values()];
	}, [fileDiff, commenting, draft, hydrationRevision]);

	const renderAnnotation = useCallback(
		(annotation: DiffLineAnnotation<DraftAnnotationGroup>) => {
			const { comments, composer } = annotation.metadata;
			return (
				<Fragment>
					{comments.map((item, index) => (
						<CommentCard key={index} comment={item.comment} outdated={item.outdated} onRemove={() => commenting?.onRemove(item.comment)} />
					))}
					{composer ? (
						<CommentForm
							key={`${composer.side}:${composer.line}`}
							value={draftText}
							onChange={setDraftText}
							onCancel={() => closeDraft(true)}
							onSave={(body) => {
								if (!fileDiff) return;
								const side = composer.side === 'old' ? 'deletions' : 'additions';
								const code = getLineTextFromDiff(fileDiff, side, composer.line) ?? '';
								commenting?.onAdd({ path: file.path, side: composer.side, line: composer.line, code, text: body });
								closeDraft(true);
							}}
						/>
					) : null}
				</Fragment>
			);
		},
		[commenting, file.path, fileDiff, draftText, closeDraft],
	);

	const renderGutterUtility = useCallback(
		(getHoveredLine: () => { lineNumber: number; side: 'deletions' | 'additions' } | undefined) => (
			<button
				type="button"
				aria-label="Comment on line"
				onClick={(event) => {
					event.stopPropagation();
					const hovered = getHoveredLine();
					if (!hovered || !fileDiff) return;
					openDraft(resolveCommentTarget(fileDiff, hovered.side, hovered.lineNumber));
				}}
				className="inline-flex size-4 translate-x-1 cursor-pointer items-center justify-center rounded-control bg-(--accent) text-(--accent-fg) shadow-(--sh-1) outline-none focus-visible:shadow-(--focus)"
			>
				<Icon icon={Plus} size={11} />
			</button>
		),
		[fileDiff, openDraft],
	);

	if (!fileDiff || fileDiff.hunks.length === 0) {
		return (
			<div className="border-t border-(--line) px-3 py-2 text-small text-(--text-3)">
				{commenting?.comments.map((comment, at) => (
					<CommentCard key={at} comment={comment} outdated onRemove={() => commenting.onRemove(comment)} />
				))}
				{file.status === 'D'
					? 'The file was deleted.'
					: file.prevPath
						? `Renamed from ${file.prevPath}.`
						: 'No lines to show: the file is empty or binary.'}
			</div>
		);
	}

	const keyboardProps =
		hasCommenting && commentTargets.length > 0
			? {
					tabIndex: 0,
					role: 'region' as const,
					'aria-label': `Diff for ${file.path}. Use Up or Down arrows to choose a line and Enter to comment.`,
					onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
						pointerDownRef.current = true;
						if (!(event.target instanceof Element) || !event.target.closest('[slot]')) setFocusedTargetIndex(null);
					},
					onFocus: (event: React.FocusEvent<HTMLDivElement>) => {
						const fromPointer = pointerDownRef.current;
						const fromRestore = restoringFocusRef.current;
						pointerDownRef.current = false;
						if (event.target === event.currentTarget && !fromPointer && !fromRestore) {
							setFocusedTargetIndex((current) => (current === null ? 0 : Math.min(current, commentTargets.length - 1)));
						}
					},
					onBlur: (event: React.FocusEvent<HTMLDivElement>) => {
						pointerDownRef.current = false;
						if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedTargetIndex(null);
					},
					onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
						if (event.target !== event.currentTarget) return;
						if (event.key === 'ArrowDown' || event.key === 'j') {
							event.preventDefault();
							setFocusedTargetIndex((current) => (current === null ? 0 : Math.min(current + 1, commentTargets.length - 1)));
						} else if (event.key === 'ArrowUp' || event.key === 'k') {
							event.preventDefault();
							setFocusedTargetIndex((current) => (current === null ? 0 : Math.max(current - 1, 0)));
						} else if (event.key === 'Home') {
							event.preventDefault();
							setFocusedTargetIndex(0);
						} else if (event.key === 'End') {
							event.preventDefault();
							setFocusedTargetIndex(commentTargets.length - 1);
						} else if ((event.key === 'Enter' || event.key === 'c') && !event.metaKey && !event.ctrlKey && !event.altKey) {
							event.preventDefault();
							const idx = focusedTargetIndex ?? 0;
							const target = commentTargets[Math.min(idx, commentTargets.length - 1)];
							if (target) openDraft({ side: target.side === 'deletions' ? 'old' : 'new', line: target.lineNumber });
						} else if (event.key === 'Escape' && focusedTargetIndex !== null) {
							event.preventDefault();
							setFocusedTargetIndex(null);
						}
					},
				}
			: {};

	return (
		<div
			ref={diffContainerRef}
			className={cn('anton-diff border-t border-(--line)', hasCommenting && 'outline-none focus-visible:shadow-(--focus-inset)')}
			{...keyboardProps}
		>
			{expandError ? (
				<div role="alert" className="flex items-center justify-between gap-2 border-b border-(--line) bg-(--bad-soft) px-2.5 py-1 text-micro text-(--bad)">
					<span className="min-w-0 truncate" title={expandError}>
						{expandError}
					</span>
					<IconBtn icon={X} size="xs" label="Dismiss expansion error" onClick={() => setExpandError(null)} />
				</div>
			) : null}
			<PierreFileDiff
				fileDiff={fileDiff}
				options={options}
				selectedLines={hasCommenting ? activeSelection : undefined}
				lineAnnotations={hasCommenting ? lineAnnotations : undefined}
				renderAnnotation={hasCommenting ? renderAnnotation : undefined}
				renderGutterUtility={hasCommenting ? renderGutterUtility : undefined}
			/>
		</div>
	);
}

export function DiffViewControls({ narrow = false, compact = false }: { narrow?: boolean; compact?: boolean }) {
	const prefs = useDiffViewPrefs();
	return (
		<div className="flex shrink-0 items-center gap-1">
			{compact ? null : (
				<Segmented label="Diff layout" role="radiogroup">
					<SegmentedItem
						role="radio"
						size="sm"
						on={prefs.diffStyle === 'split'}
						title={narrow ? 'Split view (auto-stacked while narrow)' : 'Side-by-side split view'}
						onClick={() => setDiffViewPrefs({ diffStyle: 'split' })}
					>
						Split
					</SegmentedItem>
					<SegmentedItem
						role="radio"
						size="sm"
						on={prefs.diffStyle === 'unified'}
						title="Unified stacked view"
						onClick={() => setDiffViewPrefs({ diffStyle: 'unified' })}
					>
						Stacked
					</SegmentedItem>
				</Segmented>
			)}
			<Menu>
				<MenuTrigger asChild>
					<IconBtn icon={SlidersHorizontal} size="xs" label="Diff display options" className="shrink-0" />
				</MenuTrigger>
				<MenuContent align="end" className="w-[210px]">
					{compact ? (
						<>
							<MenuLabel>Layout</MenuLabel>
							<MenuItem checked={prefs.diffStyle === 'split'} onSelect={() => setDiffViewPrefs({ diffStyle: 'split' })}>
								{narrow ? 'Split (auto-stacked)' : 'Split'}
							</MenuItem>
							<MenuItem checked={prefs.diffStyle === 'unified'} onSelect={() => setDiffViewPrefs({ diffStyle: 'unified' })}>
								Stacked
							</MenuItem>
							<MenuSeparator />
						</>
					) : null}
					<MenuLabel>Indicators</MenuLabel>
					<MenuItem checked={prefs.diffIndicators === 'bars'} onSelect={() => setDiffViewPrefs({ diffIndicators: 'bars' })}>
						Bars
					</MenuItem>
					<MenuItem checked={prefs.diffIndicators === 'classic'} onSelect={() => setDiffViewPrefs({ diffIndicators: 'classic' })}>
						Classic (+/-)
					</MenuItem>
					<MenuItem checked={prefs.diffIndicators === 'none'} onSelect={() => setDiffViewPrefs({ diffIndicators: 'none' })}>
						None
					</MenuItem>
					<MenuSeparator />
					<MenuLabel>Inline diff</MenuLabel>
					<MenuItem checked={prefs.lineDiffType === 'word-alt'} onSelect={() => setDiffViewPrefs({ lineDiffType: 'word-alt' })}>
						Word (smart)
					</MenuItem>
					<MenuItem checked={prefs.lineDiffType === 'word'} onSelect={() => setDiffViewPrefs({ lineDiffType: 'word' })}>
						Word
					</MenuItem>
					<MenuItem checked={prefs.lineDiffType === 'char'} onSelect={() => setDiffViewPrefs({ lineDiffType: 'char' })}>
						Character
					</MenuItem>
					<MenuItem checked={prefs.lineDiffType === 'none'} onSelect={() => setDiffViewPrefs({ lineDiffType: 'none' })}>
						Off
					</MenuItem>
					<MenuSeparator />
					<MenuLabel>Display</MenuLabel>
					<MenuItem
						checked={!prefs.disableBackground}
						onSelect={(event) => {
							event.preventDefault();
							setDiffViewPrefs({ disableBackground: !prefs.disableBackground });
						}}
					>
						Line backgrounds
					</MenuItem>
					<MenuItem
						checked={prefs.overflow === 'wrap'}
						onSelect={(event) => {
							event.preventDefault();
							setDiffViewPrefs({ overflow: prefs.overflow === 'wrap' ? 'scroll' : 'wrap' });
						}}
					>
						Wrap lines
					</MenuItem>
					<MenuItem
						checked={!prefs.disableLineNumbers}
						onSelect={(event) => {
							event.preventDefault();
							setDiffViewPrefs({ disableLineNumbers: !prefs.disableLineNumbers });
						}}
					>
						Line numbers
					</MenuItem>
				</MenuContent>
			</Menu>
		</div>
	);
}

/**
 * Scroll container wired to `@pierre/diffs`'s `<Virtualizer>` when browser observers exist,
 * falling back to a plain scrolling `<div>` in test DOM environments.
 */
export function DiffScrollContainer({ children, className }: { children: ReactNode; className?: string }) {
	if (typeof window !== 'undefined' && typeof IntersectionObserver !== 'undefined' && typeof ResizeObserver !== 'undefined' && !('happyDOM' in window)) {
		return <Virtualizer className={className}>{children}</Virtualizer>;
	}
	return <div className={className}>{children}</div>;
}

function useCopied(): [string | null, (what: string, text: string) => void] {
	const [copied, setCopied] = useState<string | null>(null);
	return [
		copied,
		(what, text) =>
			void navigator.clipboard?.writeText(text).then(() => {
				setCopied(what);
				setTimeout(() => setCopied(null), 1200);
			}),
	];
}

/** Revert asks twice, since it cannot be undone. */
function FileMenu({ file, sessionId, revertTo }: { file: FileDiff; sessionId?: string; revertTo: 'base' | 'pushed' }) {
	const queryClient = useQueryClient();
	const showPanel = useContext(ShowPanel);
	const [copied, copy] = useCopied();
	const [confirming, setConfirming] = useState(false);
	const revert = useMutation({
		mutationFn: () => api.revertFile(sessionId!, file.path, revertTo),
		onSuccess: () => {
			setConfirming(false);
			void queryClient.invalidateQueries({ queryKey: ['changes', sessionId] });
			void queryClient.invalidateQueries({ queryKey: ['files', sessionId] });
		},
	});
	return (
		<>
			{revert.isError ? <span className="max-w-[40%] truncate text-micro text-(--bad)">{revert.error.message}</span> : null}
			<Menu onOpenChange={(open) => (open ? undefined : setConfirming(false))}>
				<MenuTrigger asChild>
					<IconBtn icon={MoreHorizontal} size="xs" label={`Actions for ${file.path}`} className="shrink-0" />
				</MenuTrigger>
				<MenuContent align="end" className="w-[220px]">
					{sessionId && file.status !== 'D' ? (
						<MenuItem
							icon={ExternalLink}
							onSelect={() => {
								focusFile(sessionId, file.path);
								showPanel('Files');
							}}
						>
							Open in Files
						</MenuItem>
					) : null}
					<MenuItem
						icon={Copy}
						onSelect={(event) => {
							event.preventDefault();
							copy('path', file.path);
						}}
					>
						{copied === 'path' ? 'Path copied' : 'Copy path'}
					</MenuItem>
					<MenuItem
						icon={Copy}
						onSelect={(event) => {
							event.preventDefault();
							copy('diff', diffText(file));
						}}
					>
						{copied === 'diff' ? 'Diff copied' : 'Copy diff'}
					</MenuItem>
					{sessionId ? (
						<>
							<MenuSeparator />
							<MenuItem
								icon={Undo2}
								disabled={revert.isPending}
								title={revertTo === 'pushed' ? 'Drop the edits to this file since the last push' : 'Put this file back as it is on the base branch'}
								className="text-(--bad)"
								onSelect={(event) => {
									if (confirming) return revert.mutate();
									event.preventDefault();
									setConfirming(true);
								}}
							>
								{revert.isPending ? 'Reverting…' : confirming ? 'Click again to revert' : revertTo === 'pushed' ? 'Revert to the last push' : 'Revert file'}
							</MenuItem>
						</>
					) : null}
				</MenuContent>
			</Menu>
		</>
	);
}

export function useOpenFiles(files: FileDiff[], { virtualized = false }: { virtualized?: boolean } = {}) {
	const [chosen, setChosen] = useState<Map<string, boolean>>(() => new Map());
	// A handful of files open by themselves; a longer list opens only its first, so it reads as a list.
	// Virtualized panes keep long diffs open without stalling layout.
	const opensItself = (file: FileDiff, index: number) => (virtualized || file.lines.length <= 800) && (files.length <= 4 || index === 0);
	const isOpen = (path: string) => chosen.get(path) ?? opensItself(files.find((file) => file.path === path)!, files.findIndex((file) => file.path === path));
	const allOpen = files.length > 0 && files.every((file) => isOpen(file.path));
	return {
		isOpen,
		allOpen,
		set: (path: string, open: boolean) => setChosen((now) => new Map(now).set(path, open)),
		setAll: (open: boolean) => setChosen(new Map(files.map((file) => [file.path, open]))),
	};
}

type OpenFiles = ReturnType<typeof useOpenFiles>;

export function ExpandAll({ open }: { open: OpenFiles }) {
	return (
		<IconBtn
			icon={open.allOpen ? ChevronsDownUp : ChevronsUpDown}
			size="xs"
			label={open.allOpen ? 'Collapse all files' : 'Expand all files'}
			onClick={() => open.setAll(!open.allOpen)}
			className="shrink-0"
		/>
	);
}

/** A file's row stays at the top while you read down its diff. */
export function ChangeList({
	files,
	open,
	selected,
	sessionId,
	revertTo = 'base',
	review,
	narrow: narrowProp,
	loadDiffFiles,
}: {
	files: FileDiff[];
	open: OpenFiles;
	selected?: { path: string; at: number } | null;
	sessionId?: string;
	revertTo?: 'base' | 'pushed';
	review?: ReturnType<typeof useReviewComments>;
	narrow?: boolean;
	loadDiffFiles?: FileDiffContentsLoader;
}) {
	const rows = useRef(new Map<string, HTMLElement>());
	const [listRef, listSize] = useElementSize<HTMLDivElement>();
	const narrow = narrowProp ?? isDiffPaneNarrow(listSize.width);
	useEffect(() => {
		if (!selected) return;
		open.set(selected.path, true);
		rows.current.get(selected.path)?.scrollIntoView?.({ block: 'start' });
	}, [selected?.at]);
	return (
		<DiffWorkerProvider>
			<div ref={narrowProp === undefined ? listRef : undefined} role="list" aria-label="Changed files">
				{files.map((file) => {
					const isOpen = open.isOpen(file.path);
					const slash = file.path.lastIndexOf('/');
					const comments = review?.comments.filter((comment) => comment.path === file.path) ?? [];
					return (
						<section
							role="listitem"
							key={file.path}
							ref={(element) => void (element ? rows.current.set(file.path, element) : rows.current.delete(file.path))}
							aria-label={file.path}
							className="border-b border-(--line) last:border-b-0"
						>
							<div className="sticky top-0 z-[1] flex h-8 items-center gap-1.5 bg-[linear-gradient(180deg,var(--bg-surface),var(--bg-surface))] pr-1 pl-1.5">
								<button
									type="button"
									aria-expanded={isOpen}
									onClick={() => open.set(file.path, !isOpen)}
									title={file.prevPath ? `${file.prevPath} → ${file.path}` : file.path}
									className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-control pr-1 text-left outline-none focus-visible:shadow-(--focus)"
								>
									<Icon icon={ChevronRight} size={12} className={cn('text-(--text-3) transition-transform duration-(--t-fast)', isOpen && 'rotate-90')} />
									<FileIcon path={file.path} />
									<span className={cn('shrink-0 truncate text-small', selected?.path === file.path ? 'text-(--accent-text)' : 'text-(--text)')}>{file.path.slice(slash + 1)}</span>
									{slash > 0 ? <span className="min-w-0 truncate text-micro text-(--text-4)">{file.path.slice(0, slash)}</span> : null}
									{file.prevPath ? <span className="min-w-0 truncate text-micro text-(--text-4)">← {file.prevPath}</span> : null}
								</button>
								{comments.length ? (
									<span className="inline-flex shrink-0 items-center gap-1 text-micro text-(--accent-text)" title={`${comments.length} draft ${comments.length === 1 ? 'comment' : 'comments'}`}>
										<Icon icon={MessageSquare} size={12} />
										{comments.length}
									</span>
								) : null}
								{file.status === 'M' ? null : <StatusChip status={file.status} />}
								<span className="in-num shrink-0">
									<DiffStat added={file.added} removed={file.removed} />
								</span>
								<FileMenu file={file} sessionId={sessionId} revertTo={revertTo} />
							</div>
							<Disclosure open={isOpen}>
								<DiffLines
									file={file}
									narrow={narrow}
									loadDiffFiles={loadDiffFiles}
									commenting={
										review && {
											comments,
											onAdd: review.add,
											onRemove: review.remove,
										}
									}
								/>
							</Disclosure>
						</section>
					);
				})}
			</div>
		</DiffWorkerProvider>
	);
}

export function FilesSummary({ files, className }: { files: FileDiff[]; className?: string }) {
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	return (
		<span className={cn('flex shrink-0 items-center gap-2 text-micro text-(--text-3)', className)}>
			<span className="in-num">
				{files.length} {files.length === 1 ? 'file' : 'files'}
			</span>
			<span className="in-num">
				<DiffStat added={added} removed={removed} />
			</span>
		</span>
	);
}

export function DiffList({
	files,
	empty,
	sessionId,
	branch,
	base,
	loadDiffFiles,
	bounded = false,
}: {
	files: FileDiff[];
	empty?: string;
	sessionId?: string;
	branch?: string;
	base?: string;
	loadDiffFiles?: FileDiffContentsLoader;
	bounded?: boolean;
}) {
	const open = useOpenFiles(files, { virtualized: bounded });
	const [wellRef, wellSize] = useElementSize<HTMLDivElement>();
	const narrow = isDiffPaneNarrow(wellSize.width);
	const compact = isDiffToolbarCompact(wellSize.width);
	const tight = isDiffToolbarTight(wellSize.width);
	if (files.length === 0) {
		return <EmptyState art={<ChangesArt className="w-full max-w-[400px]" branch={branch} base={base} />} title="No changes yet" body={empty ?? 'Files the agent edits show up here as a diff.'} />;
	}
	const changes = <ChangeList files={files} open={open} sessionId={sessionId} narrow={narrow} loadDiffFiles={loadDiffFiles} />;
	return (
		<FileIcons>
			<div ref={wellRef} className={cn('in-well', bounded && 'flex min-h-0 flex-1 flex-col')}>
				<div className="flex h-8 shrink-0 items-center gap-2 border-b border-(--line) pr-1 pl-2.5">
					{tight ? null : <FilesSummary files={files} className="min-w-0 shrink truncate" />}
					<span className="flex-1" />
					<DiffViewControls narrow={narrow} compact={compact} />
					<ExpandAll open={open} />
				</div>
				{bounded ? <DiffScrollContainer className="min-h-0 flex-1 overflow-auto">{changes}</DiffScrollContainer> : changes}
			</div>
		</FileIcons>
	);
}
