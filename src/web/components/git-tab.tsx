import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudCheck, Copy, GitCommitHorizontal, MessageSquare, Plus, Search, Send, Undo2, X } from 'lucide-react';
import { Fragment, useContext, useEffect, useMemo, useState } from 'react';
import { EditorBar, EditorPane } from '@/components/editor-pane';
import { FileIcon, FileIcons } from '@/components/file-icons';
import { Branch, buildTree } from '@/components/file-view';
import { ChangesArt } from '@/components/illustrations';
import { Count, DiffBars, Figure, PathName, Segmented, SegmentedItem } from '@/components/instrument';
import { Btn, DiffStat, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, type ChangesPayload, type ChangesScope, isChat, refreshFor } from '@/lib/api';
import { type DiffLine, type FileDiff, parsePatch } from '@/lib/diff';
import { age } from '@/lib/format';
import { type ReviewComment, reviewMessage, SendToAgent, useReviewComments } from '@/lib/review';
import { cn } from '@/lib/utils';
import { useFocusedChange } from '@/lib/workspace';

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

/** Puts the file back as it is on the base branch, or as it was at the last push, after a second click. */
function RevertButton({ sessionId, path, to }: { sessionId: string; path: string; to: 'base' | 'pushed' }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const revert = useMutation({
		mutationFn: () => api.revertFile(sessionId, path, to),
		onSuccess: () => {
			setConfirming(false);
			void queryClient.invalidateQueries({ queryKey: ['changes', sessionId] });
			void queryClient.invalidateQueries({ queryKey: ['files', sessionId] });
		},
	});
	return (
		<>
			{revert.isError ? <span className="truncate text-[11px] text-(--danger-text)">{revert.error.message}</span> : null}
			<Btn
				variant={confirming ? 'dangerGhost' : 'ghost'}
				size="xs"
				icon={Undo2}
				disabled={revert.isPending}
				onClick={() => (confirming ? revert.mutate() : setConfirming(true))}
				onBlur={() => setConfirming(false)}
				title={to === 'pushed' ? 'Drop the edits to this file since the last push' : 'Put this file back as it is on the base branch'}
			>
				{revert.isPending ? 'Reverting…' : confirming ? 'Click again to revert' : 'Revert'}
			</Btn>
		</>
	);
}

export function DiffBlock({ file, commenting, sessionId, revertTo = 'base' }: { file: FileDiff; commenting?: Commenting; sessionId?: string; revertTo?: 'base' | 'pushed' }) {
	const [copied, setCopied] = useState(false);
	// The line being commented on, by its number, so a refetch that shifts the diff keeps the form on its line.
	const [draft, setDraft] = useState<{ side: ReviewComment['side']; line: number } | null>(null);
	const text = file.lines
		.map((line) => (line.kind === 'hunk' ? `@@ ${line.text} @@` : `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`))
		.join('\n');
	// A comment stays on its line only while that line still reads the same.
	const matches = (comment: ReviewComment, line: CodeLine) => comment.side === sideOf(line) && comment.line === line.number && comment.code === line.text;
	const codeLines = file.lines.filter((line): line is CodeLine => line.kind !== 'hunk');
	const on = (line: CodeLine) => (commenting?.comments ?? []).filter((comment) => matches(comment, line));
	const outdated = (commenting?.comments ?? []).filter((comment) => !codeLines.some((line) => matches(comment, line)));
	return (
		<div className="in-well overflow-hidden bg-(--bg-inset)">
			<div className="flex h-9 items-center gap-2 border-b border-(--border-subtle) bg-[linear-gradient(180deg,var(--card-bg-top),var(--card-bg))] pr-1.5 pl-3">
				<FileIcon path={file.path} />
				<PathName path={file.path} active className="flex-1" />
				<span className="in-num shrink-0">
					<DiffStat added={file.added} removed={file.removed} />
				</span>
				{sessionId ? <RevertButton key={file.path} sessionId={sessionId} path={file.path} to={revertTo} /> : null}
				<IconBtn
					icon={Copy}
					size="xs"
					label={copied ? 'Copied' : 'Copy diff'}
					onClick={() => {
						void navigator.clipboard?.writeText(text).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1200);
						});
					}}
				/>
			</div>
			<div className="@container overflow-x-auto pb-1.5 font-mono text-[12px] leading-[19px]">
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

function CommitList({ log }: { log: ChangesPayload['log'] }) {
	if (log.length === 0) {
		return <EmptyState icon={GitCommitHorizontal} title="No commits yet" body="Commits on the task branch show up here." />;
	}
	return (
		<ol className="m-0 list-none overflow-y-auto p-1.5">
			{log.map((entry, index) => (
				<li key={entry.sha} className="relative flex min-h-11 items-center gap-3 rounded-lg px-2.5 hover:bg-(--bg-hover)">
					{/* The branch line runs through every commit's node. */}
					<span aria-hidden className="relative flex w-3 shrink-0 justify-center self-stretch">
						<span className={cn('absolute w-px bg-(--border-default)', index === 0 ? 'top-1/2' : 'top-0', index === log.length - 1 ? 'bottom-1/2' : 'bottom-0')} />
						<span className={cn('relative mt-auto mb-auto size-2.5 rounded-full border-2', index === 0 ? 'border-(--accent-base) bg-(--accent-bg-subtle)' : 'border-(--text-disabled) bg-(--card-bg)')} />
					</span>
					<span className="min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)">{entry.subject}</span>
					{entry.pushed === false ? <span className="shrink-0 rounded-md bg-(--warning-bg) px-1.5 py-px text-[10.5px] text-(--warning-text)">Not pushed</span> : null}
					<span className="in-num shrink-0 rounded-md bg-(--alpha-white-6) px-1.5 py-px text-[10.5px] text-(--text-tertiary)">{entry.sha.slice(0, 7)}</span>
					<span className="in-num w-8 shrink-0 text-right text-[11px] text-(--text-disabled)">{age(entry.at)}</span>
				</li>
			))}
		</ol>
	);
}

/** Files on the left, the chosen file's diff below; `review` turns on line comments and `sessionId` reverting a file. */
export function DiffList({
	files,
	review,
	empty,
	sessionId,
	branch,
	base,
}: {
	files: FileDiff[];
	review?: ReturnType<typeof useReviewComments>;
	empty?: string;
	sessionId?: string;
	/** The task's branch and the one it came off, named in the empty drawing. */
	branch?: string;
	base?: string;
}) {
	const [selected, setSelected] = useState<string | null>(null);
	// A changed file a reply points at is picked here.
	const focus = useFocusedChange(sessionId);
	useEffect(() => {
		if (focus) setSelected(focus.path);
	}, [focus?.at]);
	if (files.length === 0) {
		return <EmptyState art={<ChangesArt className="w-full max-w-[400px]" branch={branch} base={base} />} title="No changes yet" body={empty ?? 'Files the agent edits show up here as a diff.'} />;
	}
	const current = files.find((file) => file.path === selected) ?? files[0];
	return (
		<FileIcons>
			{/* One file needs no list to pick from: its diff's own header names it. */}
			<div className={cn('in-card flex flex-col gap-px p-1', files.length === 1 && 'hidden')}>
				{files.map((file) => {
					const active = file.path === current.path;
					return (
						<button
							type="button"
							key={file.path}
							onClick={() => setSelected(file.path)}
							aria-current={active ? 'true' : undefined}
							className={cn(
								'flex h-8 items-center gap-2 rounded-[8px] border px-2 text-left outline-none focus-visible:shadow-(--focus-ring)',
								active
									? 'border-(--card-border) bg-[linear-gradient(180deg,var(--neutral-750),var(--neutral-800))] shadow-(--card-highlight)'
									: 'border-transparent hover:bg-(--bg-hover)',
							)}
						>
							<FileIcon path={file.path} />
							<PathName path={file.path} active={active} className="flex-1" />
							{review?.comments.some((comment) => comment.path === file.path) ? (
								<Icon icon={MessageSquare} size={12} className="text-(--accent-text)" />
							) : null}
							<span className="in-num shrink-0">
								<DiffStat added={file.added} removed={file.removed} />
							</span>
							<DiffBars added={file.added} removed={file.removed} />
						</button>
					);
				})}
			</div>
			<DiffBlock
				key={current.path}
				file={current}
				sessionId={sessionId}
				commenting={
					review && {
						comments: review.comments.filter((comment) => comment.path === current.path),
						onAdd: review.add,
						onRemove: review.remove,
					}
				}
			/>
		</FileIcons>
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

const SCOPES: Array<{ scope: ChangesScope; label: string; title: string }> = [
	{ scope: 'unpushed', label: 'Not pushed', title: 'What GitHub does not have yet: edits since the last push' },
	{ scope: 'branch', label: 'Whole branch', title: 'Everything the task changed since it began, pushed or not' },
];

/** Every folder above the changed files, so the Changes tree opens with all of them in view. */
function foldersOf(paths: string[]): Set<string> {
	const folders = new Set<string>();
	for (const path of paths) {
		const parts = path.split('/');
		for (let end = 1; end < parts.length; end += 1) folders.add(parts.slice(0, end).join('/'));
	}
	return folders;
}

/**
 * The Changes panel: the files that changed on the left as a tree, the chosen
 * one's diff on the right, in the editor layout Files uses too. It shows the
 * work GitHub does not have yet by default, so a merged pull request leaves
 * it empty; Whole branch shows everything since the task began.
 */
export function GitTab({ sessionId }: { sessionId: string }) {
	const [view, setView] = useState<'diff' | 'commits'>('diff');
	const [scope, setScope] = useState<ChangesScope>('unpushed');
	const { changes, files } = useChanges(sessionId, scope);
	const review = useReviewComments(sessionId);
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) }).data;
	const [selected, setSelected] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	// A changed file a reply points at is picked here, from the whole branch when the unpushed work lacks it.
	const focus = useFocusedChange(sessionId);
	useEffect(() => {
		if (!focus) return;
		setView('diff');
		setSelected(focus.path);
	}, [focus?.at]);
	useEffect(() => {
		if (focus && changes.data && !files.some((file) => file.path === focus.path) && scope === 'unpushed') setScope('branch');
	}, [focus?.at, changes.data]);
	const shown = useMemo(() => {
		const words = query.trim().toLowerCase();
		return words ? files.filter((file) => file.path.toLowerCase().includes(words)) : files;
	}, [files, query]);
	const tree = useMemo(() => buildTree(shown.map((file) => file.path)), [shown]);
	const expanded = useMemo(() => {
		const all = foldersOf(shown.map((file) => file.path));
		for (const folder of collapsed) all.delete(folder);
		return all;
	}, [shown, collapsed]);
	const statuses = useMemo(() => new Map(files.map((file) => [file.path, file.status])), [files]);

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
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	const current = files.find((file) => file.path === selected) ?? files[0] ?? null;

	const scopePicker = (
		<Segmented label="Show changes">
			{SCOPES.map((item) => (
				<SegmentedItem key={item.scope} size="sm" on={scope === item.scope} onClick={() => setScope(item.scope)} title={item.title}>
					{item.label}
				</SegmentedItem>
			))}
		</Segmented>
	);
	const viewPicker = (
		<Segmented label="Show">
			<SegmentedItem size="sm" on={view === 'diff'} onClick={() => setView('diff')}>
				Diff
			</SegmentedItem>
			<SegmentedItem size="sm" on={view === 'commits'} onClick={() => setView('commits')}>
				Commits
				<Count className="h-4 min-w-4 px-1">{log.length}</Count>
			</SegmentedItem>
		</Segmented>
	);

	if (files.length === 0 && view === 'diff') {
		// Pushed work is on GitHub: the PR panel shows it; nothing is waiting here.
		const pushed = scope === 'unpushed' && pushedSha;
		return (
			<div className="flex flex-col gap-2.5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					{scopePicker}
					{viewPicker}
				</div>
				{pushed ? (
					<EmptyState
						icon={CloudCheck}
						title="Nothing unpushed"
						body={
							<>
								Everything the agent changed is on GitHub. New edits show up here.{' '}
								<button type="button" onClick={() => setScope('branch')} className="text-(--accent-text) underline-offset-2 outline-none hover:underline focus-visible:shadow-(--focus-ring)">
									Show the whole branch
								</button>
							</>
						}
					/>
				) : (
					<EmptyState art={<ChangesArt className="w-full max-w-[400px]" branch={branch} base={base} />} title="No changes yet" body="Files the agent edits show up here as a diff." />
				)}
			</div>
		);
	}

	return (
		<FileIcons>
			<div className="flex min-h-0 flex-1 flex-col gap-2">
				<EditorPane
					name="changes"
					sideLabel="Changed files"
					opened={view === 'diff' ? (current?.path ?? null) : 'commits'}
					side={
						<>
							<div className="mb-1.5 flex shrink-0 items-baseline gap-2 px-1">
								<Figure value={String(files.length)} unit={files.length === 1 ? 'file changed' : 'files changed'} size="md" />
								<span className="in-num text-[12px]">
									<span className="text-(--success-text)">+{added}</span> <span className={removed ? 'text-(--danger-text)' : 'text-(--text-disabled)'}>-{removed}</span>
								</span>
							</div>
							<label className="sg-file-search mb-1.5 flex h-8 shrink-0 items-center gap-2 rounded-lg border border-(--border-subtle) bg-(--well-bg) px-2.5">
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
							</label>
							{shown.length === 0 ? (
								<div className="px-2 py-1.5 text-[12px] text-(--text-tertiary)">No changed files match.</div>
							) : (
								<Branch
									selected={view === 'diff' ? (current?.path ?? null) : null}
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
									onOpen={(path) => {
										setView('diff');
										setSelected(path);
									}}
									statusOf={(path, folder) => (folder ? undefined : statuses.get(path))}
								/>
							)}
						</>
					}
					main={(sideToggle) => (
						<>
							<EditorBar sideToggle={sideToggle} className="flex-wrap">
								{scopePicker}
								<span className="flex-1" />
								{viewPicker}
							</EditorBar>
							<div className="min-h-0 flex-1 overflow-auto">
								{view === 'commits' ? (
									<CommitList log={log} />
								) : current ? (
									<DiffBlock
										key={current.path}
										file={current}
										sessionId={sessionId}
										revertTo={scope === 'unpushed' && pushedSha ? 'pushed' : 'base'}
										commenting={{
											comments: review.comments.filter((comment) => comment.path === current.path),
											onAdd: review.add,
											onRemove: review.remove,
										}}
									/>
								) : null}
							</div>
						</>
					)}
				/>
				<ReviewBar review={review} />
			</div>
		</FileIcons>
	);
}
