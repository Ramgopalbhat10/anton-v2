import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CloudCheck, MessageSquare, Send } from '@/lib/icons';
import { useContext, useEffect, useMemo, useState } from 'react';
import { EditorBar, EditorPane } from '@/components/content/editor-pane';
import { FileIcons } from '@/components/marks/file-icons';
import { Branch, buildTree, compactTree } from '@/components/content/file-view';
import { ChangesArt } from '@/components/marks/illustrations';
import { Btn, EmptyLine, EmptyState, Icon, SearchField, Spinner } from '@/components/kit/signal';
import type { ChangesPayload } from '@/lib/api/workspace';
import { isChat } from '@/lib/api/sessions';
import type { FileDiff } from '@/lib/diff';
import { age } from '@/lib/format';
import { reviewMessage, SendToAgent, useReviewComments } from '@/lib/review';
import { useElementSize } from '@/lib/use-element-size';
import { cn } from '@/lib/utils';
import { setChangesScope, useChangesScope, useFocusedChange } from '@/lib/workspace';
import { taskQueries } from '@/lib/task-queries';
import {
	ChangeList,
	DiffViewControls,
	ExpandAll,
	FilesSummary,
	isDiffPaneNarrow,
	isDiffToolbarCompact,
	isDiffToolbarTight,
	useOpenFiles,
} from '@/components/workspace/diff-list';
import { DiffScrollContainer } from '@/components/content/diff-scroll-container';
import { api } from '@/lib/api';
import { useChanges } from '@/lib/changes';
import { createDiffFilesLoader } from '@/lib/pierre-diffs';

function CommitList({ log, title }: { log: ChangesPayload['log']; title: string }) {
	const [shown, setShown] = useState(true);
	if (log.length === 0) return null;
	return (
		<div className="mt-3 flex flex-col gap-px">
			<button
				type="button"
				aria-expanded={shown}
				onClick={() => setShown(!shown)}
				className="in-caption flex h-6 items-center gap-1 rounded-control px-1.5 text-left outline-none hover:text-(--text-3) focus-visible:shadow-(--focus)"
			>
				<Icon icon={ChevronRight} size={11} className={cn('transition-transform duration-(--t-fast)', shown && 'rotate-90')} />
				{title}
				<span className="ml-auto">{log.length}</span>
			</button>
			{shown ? (
				<ol aria-label={title} className="m-0 flex list-none flex-col gap-px p-0">
					{log.map((entry) => (
						<li key={entry.sha} title={`${entry.subject}\n${entry.sha.slice(0, 7)} · ${age(entry.at)} ago${entry.pushed === false ? ' · not pushed' : ''}`} className="flex h-[26px] items-center gap-2 rounded-control px-2 hover:bg-(--bg-hover)">
							<span
								aria-label={entry.pushed === false ? 'Not pushed' : undefined}
								className={cn('size-1.5 shrink-0 rounded-full', entry.pushed === false ? 'bg-(--warn)' : 'bg-(--text-4)')}
							/>
							<span className="min-w-0 flex-1 truncate text-small text-(--text-2)">{entry.subject}</span>
							<span className="in-num shrink-0 text-micro text-(--text-4)">{entry.sha.slice(0, 7)}</span>
						</li>
					))}
				</ol>
			) : null}
		</div>
	);
}

function ReviewBar({ review }: { review: ReturnType<typeof useReviewComments> }) {
	const send = useContext(SendToAgent);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (review.comments.length === 0) return null;
	const count = review.comments.length;
	return (
		<div className="in-pop sticky bottom-0 flex items-center gap-2 py-1.5 pr-1.5 pl-2">
			<span className="inline-flex size-6 shrink-0 items-center justify-center text-(--text-3)">
				<Icon icon={MessageSquare} size={14} />
			</span>
			<span className="min-w-0 flex-1 truncate text-small text-(--text-2)">
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

function foldersOf(paths: string[]): Set<string> {
	const folders = new Set<string>();
	for (const path of paths) {
		const parts = path.split('/');
		for (let end = 1; end < parts.length; end += 1) folders.add(parts.slice(0, end).join('/'));
	}
	return folders;
}

function LinesFigure({ file }: { file: FileDiff | undefined }) {
	if (!file || file.added + file.removed === 0) return null;
	return file.added ? (
		<span className="in-num shrink-0 text-micro text-(--ok)">+{file.added}</span>
	) : (
		<span className="in-num shrink-0 text-micro text-(--bad)">-{file.removed}</span>
	);
}

/** Shows the work GitHub does not have yet by default, so a merged pull request leaves it empty; the branch switch shows all the task changed. */
export function GitTab({ sessionId }: { sessionId: string }) {
	const scope = useChangesScope(sessionId);
	const { changes, files } = useChanges(sessionId, scope);
	const open = useOpenFiles(files, { virtualized: true });
	const [mainRef, mainSize] = useElementSize<HTMLDivElement>();
	const narrow = isDiffPaneNarrow(mainSize.width);
	const compact = isDiffToolbarCompact(mainSize.width);
	const tight = isDiffToolbarTight(mainSize.width);
	const queryClient = useQueryClient();
	const loadDiffFiles = useMemo(
		() =>
			createDiffFilesLoader(({ path, prevPath }) => api.diffFiles(sessionId, path, scope, prevPath), {
				onStale: () => void queryClient.invalidateQueries({ queryKey: ['changes', sessionId] }),
			}),
		[queryClient, sessionId, scope],
	);
	const review = useReviewComments(sessionId);
	const session = useQuery(taskQueries.session(sessionId)).data;
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
			<div className="flex h-7 items-center gap-2 text-small text-(--text-3)">
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
						<button type="button" onClick={() => setChangesScope(sessionId, 'branch')} className="text-(--accent-text) underline-offset-2 outline-none hover:underline focus-visible:shadow-(--focus)">
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
									<span className="truncate text-small text-(--text-2)" title={branch}>
										{branch}
									</span>
									{base ? <span className="text-micro text-(--text-4)">compared with {base}</span> : null}
								</div>
							) : null}
							<SearchField size="sm" value={query} onChange={setQuery} placeholder="Find a changed file" className="mb-1.5 shrink-0" />
							{files.length === 0 ? (
								<div className="px-2 py-1.5 text-small text-(--text-3)">{scope === 'branch' ? 'The branch changes no files yet.' : 'No changed files.'}</div>
							) : shown.length === 0 ? (
								<EmptyLine>No changed files match.</EmptyLine>
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
						<div ref={mainRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
							<EditorBar sideToggle={sideToggle}>
								<nav aria-label="Showing" className="flex min-w-0 flex-1 items-center gap-1 pl-1 text-small">
									<span className="min-w-0 truncate text-(--text-3)">{scope === 'branch' ? 'Branch' : 'Changes'}</span>
									<Icon icon={ChevronRight} size={11} className="shrink-0 text-(--text-3)" />
									<span className="min-w-0 truncate text-(--text)">{scope === 'branch' ? 'All changes' : 'Not pushed'}</span>
								</nav>
								{files.length ? (
									<>
										{tight ? null : <FilesSummary files={files} />}
										<DiffViewControls narrow={narrow} compact={compact} />
										<ExpandAll open={open} />
									</>
								) : null}
							</EditorBar>
							<DiffScrollContainer className="min-h-0 flex-1 overflow-auto">
								{files.length === 0 ? (
									empty
								) : (
									<ChangeList files={files} open={open} selected={selected} sessionId={sessionId} revertTo={revertTo} review={review} narrow={narrow} loadDiffFiles={loadDiffFiles} />
								)}
							</DiffScrollContainer>
						</div>
					)}
				/>
				<ReviewBar review={review} />
			</div>
		</FileIcons>
	);
}
