import { type DiffLineAnnotation, FileDiff as PierreFileDiff, Virtualizer } from '@pierre/diffs/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, ExternalLink, MessageSquare, MoreHorizontal, Plus, SlidersHorizontal, Undo2, X } from '@/lib/icons';
import { type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
	DiffWorkerProvider,
	getCachedFileDiffMetadata,
	getLineTextFromDiff,
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

export function isDiffPaneNarrow(width: number): boolean {
	return width > 0 && width < SPLIT_MIN_WIDTH;
}

/** Draft comments on one file of the diff; absent where the diff is read-only. */
export type Commenting = {
	comments: ReviewComment[];
	onAdd: (comment: ReviewComment) => void;
	onRemove: (comment: ReviewComment) => void;
};

type DraftAnnotation =
	| { kind: 'comment'; comment: ReviewComment; outdated: boolean }
	| { kind: 'composer'; side: ReviewComment['side']; line: number };

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

function CommentForm({ onSave, onCancel }: { onSave: (text: string) => void; onCancel: () => void }) {
	const [text, setText] = useState('');
	const save = () => (text.trim() ? onSave(text.trim()) : undefined);
	return (
		<div className="in-pop my-1.5 mx-2 flex w-[min(480px,calc(100%-1rem))] flex-col gap-2 border-l-2 border-l-(--accent) p-2 font-sans">
			<textarea
				autoFocus
				rows={2}
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
					if (event.key === 'Escape') onCancel();
				}}
				placeholder="What should the agent change here?"
				aria-label="Comment"
				className="sg-field w-full resize-none px-2 py-1.5 text-small leading-[18px]"
			/>
			<div className="flex justify-end gap-1.5">
				<Btn size="xs" variant="ghost" onClick={onCancel}>
					Cancel
				</Btn>
				<Btn size="xs" variant="primary" onClick={save} disabled={!text.trim()}>
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

function DiffLines({ file, commenting, narrow }: { file: FileDiff; commenting?: Commenting; narrow: boolean }) {
	// The line being commented on, by its number and side, so a refetch keeps the form anchored.
	const [draft, setDraft] = useState<{ side: ReviewComment['side']; line: number } | null>(null);
	const theme = useTheme();
	const prefs = useDiffViewPrefs();
	const rawPatch = useMemo(() => diffText(file), [file]);
	const fileDiff = useMemo(() => getCachedFileDiffMetadata(file, rawPatch), [file, rawPatch]);
	const effectiveDiffStyle: 'split' | 'unified' = prefs.diffStyle === 'split' && !narrow ? 'split' : 'unified';
	const hasCommenting = Boolean(commenting);

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
			tokenizeMaxLineLength: 4_000,
			unsafeCSS: ANTON_DIFF_UNSAFE_CSS,
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
		],
	);

	const lineAnnotations = useMemo<DiffLineAnnotation<DraftAnnotation>[]>(() => {
		if (!fileDiff || !commenting) return [];
		const fileAnnotationSide = fileDiff.type === 'deleted' ? 'deletions' : 'additions';
		const annotations: DiffLineAnnotation<DraftAnnotation>[] = commenting.comments.map((comment) => {
			const side = comment.side === 'old' ? 'deletions' : 'additions';
			const currentCode = getLineTextFromDiff(fileDiff, side, comment.line);
			const outdated = currentCode !== comment.code;
			return {
				side: outdated ? fileAnnotationSide : side,
				lineNumber: outdated ? 0 : comment.line,
				metadata: { kind: 'comment', comment, outdated },
			};
		});
		if (draft) {
			annotations.push({
				side: draft.side === 'old' ? 'deletions' : 'additions',
				lineNumber: draft.line,
				metadata: { kind: 'composer', side: draft.side, line: draft.line },
			});
		}
		return annotations;
	}, [fileDiff, commenting, draft]);

	const renderAnnotation = useCallback(
		(annotation: DiffLineAnnotation<DraftAnnotation>) => {
			const item = annotation.metadata;
			if (item.kind === 'comment') {
				return <CommentCard comment={item.comment} outdated={item.outdated} onRemove={() => commenting?.onRemove(item.comment)} />;
			}
			return (
				<CommentForm
					onCancel={() => setDraft(null)}
					onSave={(body) => {
						if (!fileDiff) return;
						const side = item.side === 'old' ? 'deletions' : 'additions';
						const code = getLineTextFromDiff(fileDiff, side, item.line) ?? '';
						commenting?.onAdd({ path: file.path, side: item.side, line: item.line, code, text: body });
						setDraft(null);
					}}
				/>
			);
		},
		[commenting, file.path, fileDiff],
	);

	const renderGutterUtility = useCallback(
		(getHoveredLine: () => { lineNumber: number; side: 'deletions' | 'additions' } | undefined) => (
			<button
				type="button"
				aria-label="Comment on line"
				onClick={(event) => {
					event.stopPropagation();
					const hovered = getHoveredLine();
					if (!hovered) return;
					setDraft({
						side: hovered.side === 'deletions' ? 'old' : 'new',
						line: hovered.lineNumber,
					});
				}}
				className="inline-flex size-4 translate-x-1 cursor-pointer items-center justify-center rounded-control bg-(--accent) text-(--accent-fg) shadow-(--sh-1) outline-none focus-visible:shadow-(--focus)"
			>
				<Icon icon={Plus} size={11} />
			</button>
		),
		[],
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

	return (
		<div className="anton-diff border-t border-(--line)">
			<PierreFileDiff
				fileDiff={fileDiff}
				options={options}
				lineAnnotations={hasCommenting ? lineAnnotations : undefined}
				renderAnnotation={hasCommenting ? renderAnnotation : undefined}
				renderGutterUtility={hasCommenting ? renderGutterUtility : undefined}
			/>
		</div>
	);
}

export function DiffViewControls({ narrow = false }: { narrow?: boolean }) {
	const prefs = useDiffViewPrefs();
	return (
		<div className="flex shrink-0 items-center gap-1">
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
			<Menu>
				<MenuTrigger asChild>
					<IconBtn icon={SlidersHorizontal} size="xs" label="Diff display options" className="shrink-0" />
				</MenuTrigger>
				<MenuContent align="end" className="w-[210px]">
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
}: {
	files: FileDiff[];
	open: OpenFiles;
	selected?: { path: string; at: number } | null;
	sessionId?: string;
	revertTo?: 'base' | 'pushed';
	review?: ReturnType<typeof useReviewComments>;
	narrow?: boolean;
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

export function FilesSummary({ files }: { files: FileDiff[] }) {
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	return (
		<span className="flex shrink-0 items-center gap-2 text-micro text-(--text-3)">
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
}: {
	files: FileDiff[];
	empty?: string;
	sessionId?: string;
	branch?: string;
	base?: string;
}) {
	const open = useOpenFiles(files);
	const [wellRef, wellSize] = useElementSize<HTMLDivElement>();
	const narrow = isDiffPaneNarrow(wellSize.width);
	if (files.length === 0) {
		return <EmptyState art={<ChangesArt className="w-full max-w-[400px]" branch={branch} base={base} />} title="No changes yet" body={empty ?? 'Files the agent edits show up here as a diff.'} />;
	}
	return (
		<FileIcons>
			<div ref={wellRef} className="in-well">
				<div className="flex h-8 items-center gap-2 border-b border-(--line) pr-1 pl-2.5">
					<FilesSummary files={files} />
					<span className="flex-1" />
					<DiffViewControls narrow={narrow} />
					<ExpandAll open={open} />
				</div>
				<ChangeList files={files} open={open} sessionId={sessionId} narrow={narrow} />
			</div>
		</FileIcons>
	);
}
