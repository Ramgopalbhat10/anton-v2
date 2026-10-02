import { useQuery } from '@tanstack/react-query';
import { Copy, GitCommitHorizontal, GitCompare, MessageSquare, Plus, Send, X } from 'lucide-react';
import { Fragment, useContext, useMemo, useState } from 'react';
import { Btn, DiffStat, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { SourceBar } from '@/components/source-bar';
import { api, refreshFor } from '@/lib/api';
import { type DiffLine, type FileDiff, parsePatch } from '@/lib/diff';
import { age } from '@/lib/format';
import { type ReviewComment, reviewMessage, SendToAgent, useReviewComments } from '@/lib/review';
import { cn } from '@/lib/utils';

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
		<div className="sticky left-2 my-1 ml-11 flex w-[min(480px,70vw)] items-start gap-2 rounded-md bg-(--bg-raised) px-2.5 py-1.5 font-sans">
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
		<div className="sticky left-2 my-1 ml-11 flex w-[min(480px,70vw)] flex-col gap-1.5 rounded-md bg-(--bg-raised) p-2 font-sans">
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
				className="w-full resize-none rounded-md bg-(--bg-surface) px-2 py-1.5 text-[12px] leading-[18px] text-(--text-primary) outline-none focus-visible:shadow-(--focus-ring)"
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
				line.kind === 'add' && 'bg-(--success-bg)',
				line.kind === 'remove' && 'bg-(--danger-bg)',
			)}
		>
			{onComment ? (
				<button
					type="button"
					aria-label={`Comment on line ${line.number}`}
					onClick={onComment}
					className="absolute top-px left-1 inline-flex size-4 items-center justify-center rounded-sm bg-(--accent-base) text-(--text-on-accent) opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
				>
					<Icon icon={Plus} size={11} />
				</button>
			) : null}
			<span className="w-11 shrink-0 pr-2.5 text-right text-(--text-disabled)">{line.number}</span>
			<span
				className={cn(
					'pr-3 pl-2 whitespace-pre',
					line.kind === 'add' ? 'text-(--success-text)' : line.kind === 'remove' ? 'text-(--danger-text)' : 'text-(--text-secondary)',
				)}
			>
				{line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
				{line.text}
			</span>
		</div>
	);
}

export function DiffBlock({ file, commenting }: { file: FileDiff; commenting?: Commenting }) {
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
		<div className="overflow-hidden rounded-lg bg-(--bg-inset)">
			<div className="flex h-8 items-center gap-2 bg-(--bg-raised) pr-1.5 pl-3">
				<div className="min-w-0 flex-1 truncate text-[12px]">{file.path}</div>
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
			<div className="overflow-x-auto py-1.5 font-mono text-[12px] leading-[18px]">
				<div className="min-w-max">
					{outdated.map((comment, at) => (
						<CommentCard key={`outdated-${at}`} comment={comment} outdated onRemove={() => commenting?.onRemove(comment)} />
					))}
					{file.lines.map((line, index) =>
						line.kind === 'hunk' ? (
							<div key={`hunk-${index}`} className="flex text-(--text-disabled)">
								<span className="w-11 shrink-0 pr-2.5 text-right">@@</span>
								<span className="whitespace-pre">{line.text}</span>
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

/** The diff and commits of a task, kept in one query so the tab count and the panel agree. */
export function useChanges(sessionId: string) {
	const changes = useQuery({
		queryKey: ['changes', sessionId],
		queryFn: () => api.changes(sessionId),
		refetchInterval: (query) => refreshFor(query.state.data?.source),
	});
	const files = useMemo(() => (changes.data ? parsePatch(changes.data.patch) : []), [changes.data]);
	return { changes, files };
}

function CommitList({ log }: { log: Array<{ sha: string; subject: string; at: string }> }) {
	if (log.length === 0) {
		return <EmptyState icon={GitCommitHorizontal} title="No commits yet" body="Commits on the task branch show up here." />;
	}
	return (
		<div className="flex flex-col gap-px">
			{log.map((entry) => (
				<div key={entry.sha} className="flex h-7 items-center gap-2 rounded-md px-2 hover:bg-(--bg-hover)">
					<span className="shrink-0 font-mono text-[11px] text-(--text-tertiary)">{entry.sha.slice(0, 7)}</span>
					<span className="min-w-0 flex-1 truncate text-[12px] text-(--text-secondary)">{entry.subject}</span>
					<span className="shrink-0 text-[11px] text-(--text-disabled)">{age(entry.at)}</span>
				</div>
			))}
		</div>
	);
}

/** Files on the left, the chosen file's diff below; `review` turns on line comments. */
export function DiffList({ files, review, empty }: { files: FileDiff[]; review?: ReturnType<typeof useReviewComments>; empty?: string }) {
	const [selected, setSelected] = useState<string | null>(null);
	if (files.length === 0) {
		return <EmptyState icon={GitCompare} title="No changes yet" body={empty ?? 'Files the agent edits show up here as a diff.'} />;
	}
	const current = files.find((file) => file.path === selected) ?? files[0];
	return (
		<>
			<div className="flex flex-col gap-px">
				{files.map((file) => {
					const active = file.path === current.path;
					return (
						<button
							type="button"
							key={file.path}
							onClick={() => setSelected(file.path)}
							className="relative flex h-7 items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
						>
							{active ? <div className="absolute inset-0 rounded-md bg-(--alpha-white-6)" /> : null}
							<div
								className={cn(
									'relative min-w-0 flex-1 truncate text-[12px]',
									active ? 'text-(--text-primary)' : 'text-(--text-secondary)',
								)}
							>
								{file.path}
							</div>
							{review?.comments.some((comment) => comment.path === file.path) ? (
								<Icon icon={MessageSquare} size={12} className="relative text-(--accent-text)" />
							) : null}
							<div className="relative">
								<DiffStat added={file.added} removed={file.removed} />
							</div>
						</button>
					);
				})}
			</div>
			<DiffBlock
				key={current.path}
				file={current}
				commenting={
					review && {
						comments: review.comments.filter((comment) => comment.path === current.path),
						onAdd: review.add,
						onRemove: review.remove,
					}
				}
			/>
		</>
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
		<div className="sticky bottom-0 flex items-center gap-2 rounded-lg bg-(--bg-raised) py-1.5 pr-1.5 pl-3 shadow-(--shadow-overlay)">
			<Icon icon={MessageSquare} size={12} className="text-(--accent-text)" />
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

export function GitTab({ sessionId }: { sessionId: string }) {
	const [view, setView] = useState<'diff' | 'commits'>('diff');
	const { changes, files } = useChanges(sessionId);
	const review = useReviewComments(sessionId);

	if (changes.isError) return <EmptyState title="Changes unavailable" body={changes.error.message} />;
	if (!changes.data) {
		return (
			<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				Loading changes
			</div>
		);
	}

	const { branch, baseBranch, log, source, at } = changes.data;
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);

	return (
		<div className="flex flex-col gap-2">
			<SourceBar sessionId={sessionId} source={source} at={at}>
				{view === 'diff' ? (
					<>
						<span className="text-(--text-disabled)">
							{files.length} {files.length === 1 ? 'FILE' : 'FILES'}
						</span>
						<span className="text-(--success-text)">+{added}</span>
						<span className="text-(--danger-text)">-{removed}</span>
					</>
				) : (
					<span className="text-(--text-disabled)">{log.length} COMMITS</span>
				)}
				<span className="hidden min-w-0 truncate text-(--text-disabled) uppercase lg:inline" title={`${baseBranch} → ${branch}`}>
					{baseBranch} → {branch}
				</span>
				<Btn
					variant="ghost"
					size="xs"
					icon={view === 'diff' ? GitCommitHorizontal : GitCompare}
					onClick={() => setView(view === 'diff' ? 'commits' : 'diff')}
				>
					{view === 'diff' ? 'Commits' : 'Diff'}
				</Btn>
			</SourceBar>
			{view === 'commits' ? <CommitList log={log} /> : <DiffList files={files} review={review} />}
			<ReviewBar review={review} />
		</div>
	);
}
