import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, CloudCheck, Copy, ExternalLink, MessageSquare, MoreHorizontal, Plus, Search, Send, Undo2, X } from 'lucide-react';
import { Fragment, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { EditorBar, EditorPane } from '@/components/editor-pane';
import { Disclosure } from '@/components/disclosure';
import { FileIcon, FileIcons } from '@/components/file-icons';
import { Branch, buildTree, compactTree, StatusChip } from '@/components/file-view';
import { ChangesArt } from '@/components/illustrations';
import { Btn, DiffStat, EmptyState, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Spinner } from '@/components/signal';
import { api, type ChangesPayload, type ChangesScope, isChat, refreshFor } from '@/lib/api';
import { type DiffLine, type FileDiff, parsePatch } from '@/lib/diff';
import { age } from '@/lib/format';
import { type ReviewComment, reviewMessage, SendToAgent, useReviewComments } from '@/lib/review';
import { cn } from '@/lib/utils';
import { focusFile, setChangesScope, ShowPanel, useChangesScope, useFocusedChange } from '@/lib/workspace';

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
		<div className="in-pop sticky left-2 my-1.5 ml-14 flex w-[min(480px,calc(100cqw-4.5rem))] items-start gap-2 border-l-2 border-l-(--accent-base) px-2.5 py-2 font-sans">
			<Icon icon={MessageSquare} size={12} className="mt-[3px] text-(--accent-text)" />
			<div className="min-w-0 flex-1 text-[12px] leading-[18px] whitespace-pre-wrap text-(--text-primary)">
				{outdated ? <div className="text-(--text-tertiary)">Line {comment.line} has changed since this comment</div> : null}
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
		<div className="in-pop sticky left-2 my-1.5 ml-14 flex w-[min(480px,calc(100cqw-4.5rem))] flex-col gap-2 border-l-2 border-l-(--accent-base) p-2 font-sans">
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
				className="w-full resize-none rounded-lg border border-(--border-subtle) bg-(--well-bg) px-2 py-1.5 text-[12px] leading-[18px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring)"
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

function CodeRow({ line, onComment }: { line: CodeLine; onComment?: () => void }) {
	return (
		<div
			className={cn(
				'group relative flex',
				line.kind === 'add' && 'bg-(--success-bg) shadow-[inset_2px_0_0_var(--success-base)]',
				line.kind === 'remove' && 'bg-(--danger-bg) shadow-[inset_2px_0_0_var(--danger-base)]',
			)}
		>
			{onComment ? (
				<button
					type="button"
					aria-label={`Comment on line ${line.number}`}
					onClick={onComment}
					className="absolute top-px left-1.5 inline-flex size-4 items-center justify-center rounded-[5px] bg-(--accent-base) text-(--text-on-accent) opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
				>
					<Icon icon={Plus} size={11} />
				</button>
			) : null}
			<span className="w-12 shrink-0 border-r border-(--border-subtle) pr-2.5 text-right text-(--text-disabled) select-none">{line.number}</span>
			<span className={cn('w-5 shrink-0 text-center select-none', line.kind === 'add' ? 'text-(--success-text)' : line.kind === 'remove' ? 'text-(--danger-text)' : 'text-transparent')}>
				{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
			</span>
			<span
				className={cn(
					'pr-3 whitespace-pre',
					line.kind === 'add' ? 'text-(--success-text)' : line.kind === 'remove' ? 'text-(--danger-text)' : 'text-(--text-secondary)',
				)}
			>
				{line.text}
			</span>
		</div>
	);
}


/** A file's diff as text, the way `git diff` prints its lines. */
function diffText(file: FileDiff): string {
	return file.lines
		.map((line) => (line.kind === 'hunk' ? `@@ ${line.text} @@` : `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`))
		.join('\n');
}

/** A file's changed lines, with line comments for the agent where `commenting` is given. */
function DiffLines({ file, commenting }: { file: FileDiff; commenting?: Commenting }) {
	// The line being commented on, by its number, so a refetch that shifts the diff keeps the form on its line.
	const [draft, setDraft] = useState<{ side: ReviewComment['side']; line: number } | null>(null);
	// A comment stays on its line only while that line still reads the same.
	const matches = (comment: ReviewComment, line: CodeLine) => comment.side === sideOf(line) && comment.line === line.number && comment.code === line.text;
	const codeLines = file.lines.filter((line): line is CodeLine => line.kind !== 'hunk');
	const on = (line: CodeLine) => (commenting?.comments ?? []).filter((comment) => matches(comment, line));
	const outdated = (commenting?.comments ?? []).filter((comment) => !codeLines.some((line) => matches(comment, line)));
	if (file.lines.length === 0) {
		return <div className="border-t border-(--border-subtle) px-3 py-2 text-[12px] text-(--text-tertiary)">{file.status === 'D' ? 'The file was deleted.' : 'No lines to show: the file is empty or binary.'}</div>;
	}
	return (
		<div className="@container overflow-x-auto border-t border-(--border-subtle) bg-(--bg-inset) py-1 font-mono text-[12px] leading-[19px]">
			<div className="min-w-max">
				{outdated.map((comment, at) => (
					<CommentCard key={`outdated-${at}`} comment={comment} outdated onRemove={() => commenting?.onRemove(comment)} />
				))}
				{file.lines.map((line, index) =>
					line.kind === 'hunk' ? (
						<div key={`hunk-${index}`} className="my-1 flex bg-(--accent-bg-subtle) py-0.5 text-(--accent-text) first:mt-0">
							<span className="w-12 shrink-0 border-r border-(--accent-border) pr-2.5 text-right opacity-70 select-none">@@</span>
							<span className="pl-2 whitespace-pre opacity-80">{line.text}</span>
						</div>
					) : (
						// Keyed by the line, not its position, so an open comment form keeps its text when the diff refreshes.
						<Fragment key={`${sideOf(line)}-${line.number}`}>
							<CodeRow line={line} onComment={commenting ? () => setDraft({ side: sideOf(line), line: line.number }) : undefined} />
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

/** Copies text, and says so on the item for a moment. */
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

/**
 * A changed file's actions: open it in Files, copy its path or diff, and
 * put it back as it was, after a second pick, since that cannot be undone.
 */
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
			{revert.isError ? <span className="max-w-[40%] truncate text-[11px] text-(--danger-text)">{revert.error.message}</span> : null}
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
								className="text-(--danger-text)"
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

/** Which changed files show their diff: the ones you opened or closed, else a few small ones open by themselves. */
function useOpenFiles(files: FileDiff[]) {
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

/** Opens or closes every file's diff at once. */
function ExpandAll({ open }: { open: OpenFiles }) {
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

/**
 * Changed files as a list, each one's diff opening right under it. A file's
 * row stays at the top while you read down its diff.
 */
function ChangeList({
	files,
	open,
	selected,
	sessionId,
	revertTo = 'base',
	review,
}: {
	files: FileDiff[];
	open: OpenFiles;
	/** The file picked in the explorer: opened, and scrolled to. */
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
						className="border-b border-(--border-subtle) last:border-b-0"
					>
						<div className="sticky top-0 z-[1] flex h-8 items-center gap-1.5 bg-[linear-gradient(180deg,var(--card-bg-top),var(--card-bg))] pr-1 pl-1.5">
							<button
								type="button"
								aria-expanded={isOpen}
								onClick={() => open.set(file.path, !isOpen)}
								title={file.path}
								className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-[6px] pr-1 text-left outline-none focus-visible:shadow-(--focus-ring)"
							>
								<Icon icon={ChevronRight} size={12} className={cn('text-(--icon-tertiary) transition-transform duration-(--duration-micro)', isOpen && 'rotate-90')} />
								<FileIcon path={file.path} />
								<span className={cn('shrink-0 truncate text-[12px]', selected?.path === file.path ? 'text-(--accent-text)' : 'text-(--text-primary)')}>{file.path.slice(slash + 1)}</span>
								{slash > 0 ? <span className="min-w-0 truncate text-[11px] text-(--text-disabled)">{file.path.slice(0, slash)}</span> : null}
							</button>
							{comments.length ? (
								<span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-(--accent-text)" title={`${comments.length} draft ${comments.length === 1 ? 'comment' : 'comments'}`}>
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

/**
 * The diff and commits of a task, kept in one query per scope so the tab
 * count and the panel agree. The count is always the unpushed work: what
 * GitHub does not have yet, so it reads 0 once a pull request has it all.
 */
export function useChanges(sessionId: string, scope: ChangesScope = 'unpushed') {
	const changes = useQuery({
		queryKey: ['changes', sessionId, scope],
		queryFn: () => api.changes(sessionId, scope),
		refetchInterval: (query) => refreshFor(query.state.data?.source),
	});
	const files = useMemo(() => (changes.data ? parsePatch(changes.data.patch) : []), [changes.data]);
	return { changes, files };
}

/** Totals for a list of changed files: "3 files +12 -4". */
function FilesSummary({ files }: { files: FileDiff[] }) {
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	return (
		<span className="flex shrink-0 items-center gap-2 text-[11px] text-(--text-tertiary)">
			<span className="in-num">
				{files.length} {files.length === 1 ? 'file' : 'files'}
			</span>
			<span className="in-num">
				<DiffStat added={added} removed={removed} />
			</span>
		</span>
	);
}

/**
 * A diff on its own, outside the editor layout, as the PR and History
 * panels show one: its totals, then each file with its diff under it.
 */
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
	/** The task's branch and the one it came off, named in the empty drawing. */
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
				<div className="flex h-8 items-center gap-2 border-b border-(--border-subtle) pr-1 pl-2.5">
					<FilesSummary files={files} />
					<span className="flex-1" />
					<ExpandAll open={open} />
				</div>
				<ChangeList files={files} open={open} sessionId={sessionId} />
			</div>
		</FileIcons>
	);
}

/** Commits on the branch, newest first, in the explorer under the changed files. */
function CommitList({ log, title }: { log: ChangesPayload['log']; title: string }) {
	const [shown, setShown] = useState(true);
	if (log.length === 0) return null;
	return (
		<div className="mt-3 flex flex-col gap-px">
			<button
				type="button"
				aria-expanded={shown}
				onClick={() => setShown(!shown)}
				className="in-caption flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-left outline-none hover:text-(--text-tertiary) focus-visible:shadow-(--focus-ring)"
			>
				<Icon icon={ChevronRight} size={11} className={cn('transition-transform duration-(--duration-micro)', shown && 'rotate-90')} />
				{title}
				<span className="ml-auto">{log.length}</span>
			</button>
			{shown ? (
				<ol aria-label={title} className="m-0 flex list-none flex-col gap-px p-0">
					{log.map((entry) => (
						<li key={entry.sha} title={`${entry.subject}\n${entry.sha.slice(0, 7)} · ${age(entry.at)} ago${entry.pushed === false ? ' · not pushed' : ''}`} className="flex h-[26px] items-center gap-2 rounded-[7px] px-2 hover:bg-(--bg-hover)">
							<span
								aria-label={entry.pushed === false ? 'Not pushed' : undefined}
								className={cn('size-1.5 shrink-0 rounded-full', entry.pushed === false ? 'bg-(--warning-base)' : 'bg-(--text-disabled)')}
							/>
							<span className="min-w-0 flex-1 truncate text-[12px] text-(--text-secondary)">{entry.subject}</span>
							<span className="in-num shrink-0 text-[10.5px] text-(--text-disabled)">{entry.sha.slice(0, 7)}</span>
						</li>
					))}
				</ol>
			) : null}
		</div>
	);
}

/** Draft comments waiting to go to the agent as one message. */
function ReviewBar({ review }: { review: ReturnType<typeof useReviewComments> }) {
	const send = useContext(SendToAgent);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (review.comments.length === 0) return null;
	const count = review.comments.length;
	return (
		<div className="in-pop sticky bottom-0 flex items-center gap-2 py-1.5 pr-1.5 pl-2">
			<span className="inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-(--accent-bg-subtle) text-(--accent-text)">
				<Icon icon={MessageSquare} size={12} />
			</span>
			<span className="min-w-0 flex-1 truncate text-[12px] text-(--text-secondary)">
				{error ?? `${count} ${count === 1 ? 'comment' : 'comments'} for the agent`}
			</span>
			<Btn size="xs" variant="ghost" onClick={review.clear}>
				Discard
			</Btn>
			<Btn
				size="xs"
				variant="primary"
				icon={Send}
				disabled={!send || sending}
				onClick={async () => {
					// Only what was sent is cleared; a comment added meanwhile stays for the next send.
					const sent = review.comments;
					setSending(true);
					setError(null);
					try {
						await send?.(reviewMessage(sent));
						review.removeAll(sent);
					} catch (failure) {
						setError(failure instanceof Error ? `Not sent: ${failure.message}` : 'Not sent');
					} finally {
						setSending(false);
					}
				}}
			>
				{sending ? 'Sending…' : 'Send to agent'}
			</Btn>
		</div>
	);
}

/** Every folder above the changed files, so the Changes tree opens with all of them in view. */
function foldersOf(paths: string[]): Set<string> {
	const folders = new Set<string>();
	for (const path of paths) {
		const parts = path.split('/');
		for (let end = 1; end < parts.length; end += 1) folders.add(parts.slice(0, end).join('/'));
	}
	return folders;
}

/** The lines a file adds, or removes when it only removes, beside it in the explorer. */
function LinesFigure({ file }: { file: FileDiff | undefined }) {
	if (!file || file.added + file.removed === 0) return null;
	return file.added ? (
		<span className="in-num shrink-0 text-[10.5px] text-(--success-text)">+{file.added}</span>
	) : (
		<span className="in-num shrink-0 text-[10.5px] text-(--danger-text)">-{file.removed}</span>
	);
}

/**
 * The Changes panel, in the editor layout Files uses too: the changed files
 * as a tree in the explorer, and beside it every changed file with its diff
 * opening under it. It shows the work GitHub does not have yet by default,
 * so a merged pull request leaves it empty; the explorer's branch switch
 * shows everything the task changed since it began, and its commits.
 */
export function GitTab({ sessionId }: { sessionId: string }) {
	const scope = useChangesScope(sessionId);
	const { changes, files } = useChanges(sessionId, scope);
	const open = useOpenFiles(files);
	const review = useReviewComments(sessionId);
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) }).data;
	const [selected, setSelected] = useState<{ path: string; at: number } | null>(null);
	const [query, setQuery] = useState('');
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	// A changed file a reply points at is picked here, from the whole branch when the unpushed work lacks it.
	const focus = useFocusedChange(sessionId);
	useEffect(() => {
		if (focus) setSelected({ path: focus.path, at: focus.at });
	}, [focus?.at]);
	useEffect(() => {
		if (focus && changes.data && !files.some((file) => file.path === focus.path) && scope === 'unpushed') setChangesScope(sessionId, 'branch');
	}, [focus?.at, changes.data]);
	const shown = useMemo(() => {
		const words = query.trim().toLowerCase();
		return words ? files.filter((file) => file.path.toLowerCase().includes(words)) : files;
	}, [files, query]);
	const tree = useMemo(() => compactTree(buildTree(shown.map((file) => file.path))), [shown]);
	const expanded = useMemo(() => {
		const all = foldersOf(shown.map((file) => file.path));
		for (const folder of collapsed) all.delete(folder);
		return all;
	}, [shown, collapsed]);
	const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

	// A chat has no branch; a task names its own only once it has a workspace to make it in.
	const branch = session && !isChat(session) && session.workspace ? session.branch : undefined;
	const base = session && !isChat(session) ? session.baseBranch : undefined;
	if (changes.isError) return <EmptyState title="Changes unavailable" body={changes.error.message} />;
	if (!changes.data) {
		return (
			<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				Loading changes
			</div>
		);
	}
	const { log, pushedSha } = changes.data;
	const commits = scope === 'branch' ? log : log.filter((entry) => entry.pushed !== true);
	const revertTo = scope === 'unpushed' && pushedSha ? 'pushed' : 'base';

	const empty =
		scope === 'unpushed' && pushedSha ? (
			// Pushed work is on GitHub: the PR panel shows it; nothing is waiting here.
			<EmptyState
				icon={CloudCheck}
				title="Nothing unpushed"
				body={
					<>
						Everything the agent changed is on GitHub. New edits show up here.{' '}
						<button type="button" onClick={() => setChangesScope(sessionId, 'branch')} className="text-(--accent-text) underline-offset-2 outline-none hover:underline focus-visible:shadow-(--focus-ring)">
							Show the whole branch
						</button>
					</>
				}
			/>
		) : (
			<div className="p-3">
				<EmptyState art={<ChangesArt className="w-full max-w-[400px]" branch={branch} base={base} />} title="No changes yet" body="Files the agent edits show up here as a diff." />
			</div>
		);

	return (
		<FileIcons>
			<div className="flex min-h-0 flex-1 flex-col gap-2">
				<EditorPane
					name="changes"
					sessionId={sessionId}
					mode={scope === 'branch' ? 'branch' : 'changes'}
					sideLabel="Changed files tree"
					opened={selected?.path ?? 'all'}
					side={
						<>
							{scope === 'branch' && branch ? (
								<div className="mb-1.5 flex min-w-0 flex-col gap-0.5 px-1.5 pt-0.5">
									<span className="truncate font-mono text-[11.5px] text-(--text-secondary)" title={branch}>
										{branch}
									</span>
									{base ? <span className="text-[11px] text-(--text-disabled)">compared with {base}</span> : null}
								</div>
							) : null}
							<label className="sg-file-search mb-1.5 flex h-7 shrink-0 items-center gap-2 rounded-[8px] border border-(--border-subtle) bg-(--bg-inset) px-2">
								<Icon icon={Search} size={12} className="text-(--icon-tertiary)" />
								<input
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === 'Escape') setQuery('');
									}}
									placeholder="Find a changed file"
									aria-label="Find a changed file"
									className="min-w-0 flex-1 bg-transparent text-[12px] text-(--text-primary) outline-none placeholder:text-(--text-disabled)"
								/>
								{query ? <IconBtn icon={X} size="xs" label="Clear the search" onClick={() => setQuery('')} className="-mr-1 size-5" /> : null}
							</label>
							{files.length === 0 ? (
								<div className="px-2 py-1.5 text-[12px] text-(--text-tertiary)">{scope === 'branch' ? 'The branch changes no files yet.' : 'No changed files.'}</div>
							) : shown.length === 0 ? (
								<div className="px-2 py-1.5 text-[12px] text-(--text-tertiary)">No changed files match.</div>
							) : (
								<Branch
									selected={selected?.path ?? null}
									node={tree}
									depth={0}
									expanded={expanded}
									onToggle={(path) =>
										setCollapsed((now) => {
											const next = new Set(now);
											if (next.has(path)) next.delete(path);
											else next.add(path);
											return next;
										})
									}
									onOpen={(path) => setSelected({ path, at: Date.now() })}
									statusOf={(path, folder) => (folder ? undefined : byPath.get(path)?.status)}
									detailOf={(path) => <LinesFigure file={byPath.get(path)} />}
								/>
							)}
							<CommitList log={commits} title={scope === 'branch' ? 'Commits' : 'Commits not pushed'} />
						</>
					}
					main={(sideToggle) => (
						<>
							<EditorBar sideToggle={sideToggle}>
								<nav aria-label="Showing" className="flex min-w-0 flex-1 items-center gap-1 pl-1 text-[12px]">
									<span className="shrink-0 text-(--text-tertiary)">{scope === 'branch' ? 'Branch' : 'Changes'}</span>
									<Icon icon={ChevronRight} size={11} className="text-(--icon-tertiary)" />
									<span className="min-w-0 truncate text-(--text-primary)">{scope === 'branch' ? 'All changes' : 'Not pushed'}</span>
								</nav>
								{files.length ? (
									<>
										<FilesSummary files={files} />
										<ExpandAll open={open} />
									</>
								) : null}
							</EditorBar>
							<div className="min-h-0 flex-1 overflow-auto">
								{files.length === 0 ? (
									empty
								) : (
									<ChangeList files={files} open={open} selected={selected} sessionId={sessionId} revertTo={revertTo} review={review} />
								)}
							</div>
						</>
					)}
				/>
				<ReviewBar review={review} />
			</div>
		</FileIcons>
	);
}
