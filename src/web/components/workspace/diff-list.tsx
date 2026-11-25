import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, ExternalLink, MessageSquare, MoreHorizontal, Plus, Undo2, X } from '@/lib/icons';
import { Fragment, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Disclosure } from '@/components/kit/disclosure';
import { FileIcon, FileIcons } from '@/components/marks/file-icons';
import { StatusChip } from '@/components/content/file-view';
import { ChangesArt } from '@/components/marks/illustrations';
import { Btn, DiffStat, EmptyState, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { DiffLine, FileDiff } from '@/lib/diff';
import { hashText, highlightDiff } from '@/lib/highlight';
import { type ReviewComment, useReviewComments } from '@/lib/review';
import { cn } from '@/lib/utils';
import { focusFile, ShowPanel } from '@/lib/workspace';

/** Draft comments on one file of the diff; absent where the diff is read-only. */
export type Commenting = {
	comments: ReviewComment[];
	onAdd: (comment: ReviewComment) => void;
	onRemove: (comment: ReviewComment) => void;
};

type CodeLine = Exclude<DiffLine, { kind: 'hunk' }>;

const sideOf = (line: CodeLine): ReviewComment['side'] => (line.kind === 'remove' ? 'old' : 'new');

function CommentCard({ comment, onRemove, outdated }: { comment: ReviewComment; onRemove: () => void; outdated?: boolean }) {
	return (
		<div className="in-pop sticky left-2 my-1.5 ml-14 flex w-[min(480px,calc(100cqw-4.5rem))] items-start gap-2 border-l-2 border-l-(--accent) px-2.5 py-2 font-sans">
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
		<div className="in-pop sticky left-2 my-1.5 ml-14 flex w-[min(480px,calc(100cqw-4.5rem))] flex-col gap-2 border-l-2 border-l-(--accent) p-2 font-sans">
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

type Token = { content: string; color?: string };

function CodeRow({ line, tokens, onComment }: { line: CodeLine; tokens?: Token[] | null; onComment?: () => void }) {
	return (
		<div
			className={cn(
				'group relative flex',
				line.kind === 'add' && 'bg-(--diff-add) shadow-[inset_2px_0_0_var(--diff-add-mark)]',
				line.kind === 'remove' && 'bg-(--diff-del) shadow-[inset_2px_0_0_var(--diff-del-mark)]',
			)}
		>
			{onComment ? (
				<button
					type="button"
					aria-label={`Comment on line ${line.number}`}
					onClick={onComment}
					className="absolute top-px left-1.5 inline-flex size-4 items-center justify-center rounded-control bg-(--accent) text-(--accent-fg) opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
				>
					<Icon icon={Plus} size={11} />
				</button>
			) : null}
			<span className="w-12 shrink-0 pr-2 text-right text-(--text-4) tabular-nums select-none">{line.number}</span>
			<span className={cn('w-4 shrink-0 text-center select-none', line.kind === 'add' ? 'text-(--ok)' : line.kind === 'remove' ? 'text-(--bad)' : 'text-transparent')}>
				{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
			</span>
			<span
				className={cn(
					'pr-3 whitespace-pre',
					line.kind === 'context' ? 'text-(--text-2)' : 'text-(--text)',
				)}
			>
				{tokens
					? tokens.map((token, at) => (
							<span key={at} style={{ color: token.color }}>
								{token.content}
							</span>
						))
					: line.text}
			</span>
		</div>
	);
}

function diffText(file: FileDiff): string {
	return file.lines
		.map((line) => (line.kind === 'hunk' ? `@@ ${line.text} @@` : `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`))
		.join('\n');
}

function DiffLines({ file, commenting }: { file: FileDiff; commenting?: Commenting }) {
	// The line being commented on, by its number, so a refetch that shifts the diff keeps the form on its line.
	const [draft, setDraft] = useState<{ side: ReviewComment['side']; line: number } | null>(null);
	// A comment stays on its line only while that line still reads the same.
	const matches = (comment: ReviewComment, line: CodeLine) => comment.side === sideOf(line) && comment.line === line.number && comment.code === line.text;
	const codeLines = file.lines.filter((line): line is CodeLine => line.kind !== 'hunk');
	const on = (line: CodeLine) => (commenting?.comments ?? []).filter((comment) => matches(comment, line));
	const outdated = (commenting?.comments ?? []).filter((comment) => !codeLines.some((line) => matches(comment, line)));
	const cacheText = useMemo(() => diffText(file), [file]);
	const cacheHash = useMemo(() => hashText(cacheText), [cacheText]);
	const colored = useQuery({
		queryKey: ['highlight-diff', file.path, cacheText.length, cacheHash],
		queryFn: () => highlightDiff(file.lines, file.path),
		enabled: file.lines.length > 0,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 60_000,
	});
	const tokens = colored.data ?? null;
	if (file.lines.length === 0) {
		return <div className="border-t border-(--line) px-3 py-2 text-small text-(--text-3)">{file.status === 'D' ? 'The file was deleted.' : 'No lines to show: the file is empty or binary.'}</div>;
	}
	return (
		<div className="@container overflow-x-auto border-t border-(--line) py-1 font-mono text-small leading-5">
			<div className="min-w-max">
				{outdated.map((comment, at) => (
					<CommentCard key={`outdated-${at}`} comment={comment} outdated onRemove={() => commenting?.onRemove(comment)} />
				))}
				{file.lines.map((line, index) =>
					line.kind === 'hunk' ? (
						<div key={`hunk-${index}`} className="my-1 flex bg-(--accent-soft) text-(--accent-text) first:mt-0">
							<span className="w-12 shrink-0 pr-2 text-right select-none">@@</span>
							<span className="pl-4 whitespace-pre">{line.text}</span>
						</div>
					) : (
						// Keyed by the line, not its position, so an open comment form keeps its text when the diff refreshes.
						<Fragment key={`${sideOf(line)}-${line.number}`}>
							<CodeRow line={line} tokens={tokens?.[index]} onComment={commenting ? () => setDraft({ side: sideOf(line), line: line.number }) : undefined} />
							{on(line).map((comment, at) => (
								<CommentCard key={at} comment={comment} onRemove={() => commenting?.onRemove(comment)} />
							))}
							{commenting && draft?.side === sideOf(line) && draft.line === line.number ? (
								<CommentForm
									onCancel={() => setDraft(null)}
									onSave={(body) => {
										commenting.onAdd({ path: file.path, side: sideOf(line), line: line.number, code: line.text, text: body });
										setDraft(null);
									}}
								/>
							) : null}
						</Fragment>
					),
				)}
			</div>
		</div>
	);
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

export function useOpenFiles(files: FileDiff[]) {
	const [chosen, setChosen] = useState<Map<string, boolean>>(() => new Map());
	// A handful of files open by themselves; a longer list opens only its first, so it reads as a list.
	const opensItself = (file: FileDiff, index: number) => file.lines.length <= 800 && (files.length <= 4 || index === 0);
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
}: {
	files: FileDiff[];
	open: OpenFiles;
	selected?: { path: string; at: number } | null;
	sessionId?: string;
	revertTo?: 'base' | 'pushed';
	review?: ReturnType<typeof useReviewComments>;
}) {
	const rows = useRef(new Map<string, HTMLElement>());
	useEffect(() => {
		if (!selected) return;
		open.set(selected.path, true);
		rows.current.get(selected.path)?.scrollIntoView?.({ block: 'start' });
	}, [selected?.at]);
	return (
		<div role="list" aria-label="Changed files">
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
								title={file.path}
								className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-control pr-1 text-left outline-none focus-visible:shadow-(--focus)"
							>
								<Icon icon={ChevronRight} size={12} className={cn('text-(--text-3) transition-transform duration-(--t-fast)', isOpen && 'rotate-90')} />
								<FileIcon path={file.path} />
								<span className={cn('shrink-0 truncate text-small', selected?.path === file.path ? 'text-(--accent-text)' : 'text-(--text)')}>{file.path.slice(slash + 1)}</span>
								{slash > 0 ? <span className="min-w-0 truncate text-micro text-(--text-4)">{file.path.slice(0, slash)}</span> : null}
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
	if (files.length === 0) {
		return <EmptyState art={<ChangesArt className="w-full max-w-[400px]" branch={branch} base={base} />} title="No changes yet" body={empty ?? 'Files the agent edits show up here as a diff.'} />;
	}
	return (
		<FileIcons>
			<div className="in-well">
				<div className="flex h-8 items-center gap-2 border-b border-(--line) pr-1 pl-2.5">
					<FilesSummary files={files} />
					<span className="flex-1" />
					<ExpandAll open={open} />
				</div>
				<ChangeList files={files} open={open} sessionId={sessionId} />
			</div>
		</FileIcons>
	);
}
