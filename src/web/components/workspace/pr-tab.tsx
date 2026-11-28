import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Check, ChevronDown, CircleCheck, CircleDot, CircleX, Copy, GitCommitHorizontal, GitPullRequest, MessageSquare } from '@/lib/icons';
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';
import { DiffList, type ForeignDiffComment } from '@/components/workspace/diff-list';
import { focusChange, useFocusedChange } from '@/lib/workspace';
import { createDiffFilesLoader } from '@/lib/pierre-diffs';
import { Count, Segmented, SegmentedItem } from '@/components/kit/instrument';
import { Markdown } from '@/components/content/markdown';
import { MergeBox } from '@/components/workspace/pr-merge';
import { PR_ICON, prChipStyle, prColor, prTone } from '@/components/marks/pr-status';
import { Avatar, EmptyState, Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Spinner } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { CheckRun, DiscussionEntry, PullRequestDetail, PullRequestItem, PullRequestState } from '@/lib/api/workspace';
import { parsePatch } from '@/lib/diff';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';
import { taskQueries } from '@/lib/task-queries';

const STATE_LABEL: Record<PullRequestState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const STATE_ICON = PR_ICON;

function StatePill({ state, size = 'md' }: { state: PullRequestState | null; size?: 'sm' | 'md' }) {
	return (
		<span
			className={cn('inline-flex shrink-0 items-center gap-1 rounded-inner font-medium whitespace-nowrap', size === 'md' ? 'h-5 px-1.5 text-small' : 'h-[18px] px-1.5 text-micro')}
			style={prChipStyle(state ?? 'unknown')}
		>
			<Icon icon={STATE_ICON[state ?? 'open']} size={size === 'md' ? 13 : 11} />
			{state ? STATE_LABEL[state] : 'Unknown'}
		</span>
	);
}

function BranchChip({ name }: { name: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span className="inline-flex h-5 min-w-0 items-center gap-1 rounded-control bg-(--bg-active) pr-0.5 pl-1.5 text-micro text-(--text-2)">
			<span className="truncate">{name}</span>
			<button
				type="button"
				aria-label={copied ? 'Copied' : `Copy ${name}`}
				title={copied ? 'Copied' : 'Copy the branch name'}
				onClick={() =>
					void navigator.clipboard?.writeText(name).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1200);
					})
				}
				className="inline-flex size-4 shrink-0 items-center justify-center rounded-control text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)"
			>
				<Icon icon={copied ? Check : Copy} size={10} />
			</button>
		</span>
	);
}

function PullPicker({ pulls, selected, onSelect }: { pulls: PullRequestItem[]; selected: PullRequestItem; onSelect: (number: number) => void }) {
	if (pulls.length < 2) return <span className="in-num shrink-0 text-small text-(--text-2)">#{selected.number}</span>;
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					aria-label={`#${selected.number} of ${pulls.length} pull requests`}
					className="inline-flex h-6 shrink-0 items-center gap-1 rounded-control px-1.5 text-small text-(--text-2) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus)"
				>
					<span className="in-num">#{selected.number}</span>
					<span className="text-(--text-4)">
						{pulls.findIndex((pull) => pull.number === selected.number) + 1} of {pulls.length}
					</span>
					<Icon icon={ChevronDown} size={12} className="text-(--text-3)" />
				</button>
			</MenuTrigger>
			<MenuContent align="start" className="w-[320px]">
				<MenuLabel>Pull requests in this thread</MenuLabel>
				{pulls.map((pull) => (
					<MenuItem key={pull.url} checked={pull.number === selected.number} onSelect={() => onSelect(pull.number)} hint={age(pull.openedAt)}>
						<span className="flex min-w-0 items-center gap-2">
							<span className="inline-flex shrink-0" style={{ color: prColor(pull.state) }}>
								<Icon icon={STATE_ICON[pull.state ?? 'open']} size={12} />
							</span>
							<span className="in-num shrink-0 text-(--text-3)">#{pull.number}</span>
							<span className="truncate">{pull.title}</span>
						</span>
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}

const CHECK_ICON = { passed: CircleCheck, failed: CircleX, pending: CircleDot, skipped: CircleDot } as const;
const CHECK_TONE = { passed: prTone('passed'), failed: prTone('failing'), pending: prTone('running'), skipped: 'var(--text-4)' } as const;

type Section = 'changes' | 'description' | 'discussion' | 'commits' | 'checks';

/** Line comments grouped into threads: starters carry their replies, so the inline card reads like the host's conversation. */
function threadsOf(pull: PullRequestDetail): ForeignDiffComment[] {
	const starters = pull.discussion.filter((entry) => entry.kind === 'line' && entry.path && entry.line && !entry.replyTo);
	const replies = new Map<string, Array<{ author: string; body: string; at: string }>>();
	for (const entry of pull.discussion) {
		if (entry.kind !== 'line' || !entry.replyTo) continue;
		const list = replies.get(entry.replyTo) ?? [];
		list.push({ author: entry.author, body: entry.body, at: entry.at });
		replies.set(entry.replyTo, list);
	}
	return starters.map((entry) => ({
		path: entry.path!,
		side: entry.side ?? 'new',
		line: entry.line!,
		author: entry.author,
		body: entry.body,
		at: entry.at,
		outdated: entry.outdated,
		resolved: entry.resolved,
		replies: replies.get(entry.id),
	}));
}

function PullChanges({ sessionId, number, bounded = false, foreign = [] }: { sessionId: string; number: number; bounded?: boolean; foreign?: ForeignDiffComment[] }) {
	const queryClient = useQueryClient();
	const diff = useQuery({ queryKey: ['pull', sessionId, number, 'diff'], queryFn: () => api.pullDiff(sessionId, number), staleTime: 60_000 });
	const files = useMemo(() => (diff.data ? parsePatch(diff.data.patch) : []), [diff.data]);
	const loadDiffFiles = useMemo(
		() =>
			createDiffFilesLoader(({ path, prevPath }) => api.pullDiffFiles(sessionId, number, path, prevPath), {
				onStale: () => void queryClient.invalidateQueries({ queryKey: ['pull', sessionId, number, 'diff'] }),
			}),
		[queryClient, sessionId, number],
	);
	const focused = useFocusedChange(sessionId);
	if (diff.isError) return <EmptyState title="Diff unavailable" body={diff.error.message} />;
	if (!diff.data) return <Loading>Reading the diff from GitHub</Loading>;
	return <DiffList files={files} empty="This pull request changes no files." loadDiffFiles={loadDiffFiles} bounded={bounded} foreign={foreign} selected={focused} />;
}

function Discussion({ pull, onJump }: { pull: PullRequestDetail; onJump?: (entry: DiscussionEntry) => void }) {
	if (pull.discussion.length === 0) return <EmptyState icon={MessageSquare} title="No discussion yet" body="Comments and reviews on GitHub show up here." />;
	// Replies nest under their thread starter instead of floating loose in the timeline.
	const repliesOf = new Map<string, DiscussionEntry[]>();
	for (const entry of pull.discussion) {
		if (!entry.replyTo) continue;
		const list = repliesOf.get(entry.replyTo) ?? [];
		list.push(entry);
		repliesOf.set(entry.replyTo, list);
	}
	const roots = pull.discussion.filter((entry) => !entry.replyTo || !pull.discussion.some((other) => other.id === entry.replyTo));
	const orphanReplies = pull.discussion.filter((entry) => entry.replyTo && !roots.includes(entry) && !pull.discussion.some((other) => other.id === entry.replyTo));
	const timeline = [...roots, ...orphanReplies].sort((a, b) => a.at.localeCompare(b.at));
	// A thread reads as one connected conversation: replies share the starter's avatar column on a spine,
	// with compact headers — repeating "commented on path:line" per reply dissolved the grouping.
	const header = (entry: DiscussionEntry, compact: boolean) => (
		<div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-small">
			<span className="font-medium text-(--text)">{entry.author}</span>
			{compact ? (
				<span className="in-num text-micro text-(--text-4)">· {entry.at ? age(entry.at) : ''}</span>
			) : (
				<Fragment>
					<span className="text-(--text-3)">{entry.kind === 'review' ? 'reviewed' : entry.kind === 'line' ? 'commented on' : 'commented'}</span>
					{entry.path ? (
						onJump && entry.line ? (
							<button
								type="button"
								onClick={() => onJump(entry)}
								title="Show in the diff"
								className="min-w-0 truncate rounded-control text-micro text-(--accent-text) outline-none hover:underline focus-visible:shadow-(--focus)"
							>
								{entry.path}:{entry.line}
							</button>
						) : (
							<span className="min-w-0 truncate text-micro text-(--text-2)">
								{entry.path}
								{entry.line ? `:${entry.line}` : ''}
							</span>
						)
					) : null}
					{entry.outdated ? <span className="rounded-control bg-(--warn-soft) px-1 py-px text-micro text-(--warn)">outdated</span> : null}
					{entry.resolved ? <span className="rounded-control bg-(--ok-soft) px-1 py-px text-micro text-(--ok)">resolved</span> : null}
					{entry.verdict ? (
						<span className={cn('rounded-control px-1.5 py-px text-micro', entry.verdict === 'approved' ? 'bg-(--ok-soft) text-(--ok)' : 'bg-(--warn-soft) text-(--warn)')}>{entry.verdict}</span>
					) : null}
					<span className="in-num ml-auto text-micro text-(--text-4)">{entry.at ? age(entry.at) : ''}</span>
				</Fragment>
			)}
		</div>
	);
	// Reddit-style threading: replies indent one step and connect to the starter's spine with a curved elbow;
	// the spine runs in segments — the starter drops it below its avatar, each non-last reply continues it.
	const row = (entry: DiscussionEntry, compact: boolean, link?: { spineStart?: boolean; elbow?: boolean; continues?: boolean }) => (
		<div className={cn('relative flex gap-2.5', link?.elbow ? 'ml-6' : '')}>
			{link?.spineStart ? <span aria-hidden className="absolute top-[18px] -bottom-2.5 left-[7.5px] w-px bg-(--line-strong)" /> : null}
			{link?.elbow ? <span aria-hidden className="absolute top-0 -left-[16.5px] h-[9px] w-[16.5px] rounded-bl-control border-b border-l border-(--line-strong)" /> : null}
			{link?.continues ? <span aria-hidden className="absolute top-[9px] -bottom-2.5 -left-[16.5px] w-px bg-(--line-strong)" /> : null}
			<Avatar name={entry.author} size="xs" />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				{header(entry, compact)}
				{entry.body ? (
					<div className="text-body break-words text-(--text-2)">
						<Markdown text={entry.body} />
					</div>
				) : null}
			</div>
		</div>
	);
	const renderThread = (entry: DiscussionEntry) => {
		const replies = (repliesOf.get(entry.id) ?? []).slice().sort((a, b) => a.at.localeCompare(b.at));
		return (
			<li key={entry.id} className="relative flex flex-col gap-2.5 border-b border-(--line) px-3 py-2.5 last:border-b-0">
				{row(entry, false, { spineStart: replies.length > 0 })}
				{replies.map((reply, at) => (
					<Fragment key={reply.id}>{row(reply, true, { elbow: true, continues: at < replies.length - 1 })}</Fragment>
				))}
			</li>
		);
	};
	return (
		<ol className="in-well m-0 flex list-none flex-col p-0">{timeline.map((entry) => renderThread(entry))}</ol>
	);
}

function Commits({ pull }: { pull: PullRequestDetail }) {
	if (pull.commits.length === 0) return <EmptyState icon={GitCommitHorizontal} title="No commits" />;
	return (
		<ol className="in-well m-0 list-none p-0">
			{pull.commits.map((commit) => (
				<li key={commit.sha} className="flex h-9 items-center gap-2.5 border-b border-(--line) px-3 last:border-b-0">
					<Icon icon={GitCommitHorizontal} size={13} className="shrink-0 text-(--text-3)" />
					<span className="min-w-0 flex-1 truncate text-body text-(--text)">{commit.subject}</span>
					<span className="in-num shrink-0 text-micro text-(--text-4)">{commit.sha.slice(0, 7)}</span>
				</li>
			))}
		</ol>
	);
}

function Checks({ pull }: { pull: PullRequestDetail }) {
	if (pull.checks.length === 0) return <EmptyState icon={CircleCheck} title="No checks" body="This repository runs no checks on the pull request's head." />;
	return (
		<ol className="in-well m-0 list-none p-0">
			{pull.checks.map((check, index) => (
				<li key={`${check.name}-${index}`} className="flex h-9 items-center gap-2.5 border-b border-(--line) px-3 last:border-b-0">
					<Icon icon={CHECK_ICON[check.status]} size={14} className="shrink-0" style={{ color: CHECK_TONE[check.status] }} />
					<span className="shrink-0 text-body text-(--text)">{check.name}</span>
					<span className="min-w-0 flex-1 truncate text-small text-(--text-3)">{check.summary}</span>
					{check.url ? (
						<a href={check.url} target="_blank" rel="noreferrer" className="shrink-0 text-small text-(--accent-text) underline-offset-2 hover:underline">
							Details
						</a>
					) : null}
				</li>
			))}
		</ol>
	);
}

function Loading({ children }: { children: ReactNode }) {
	return (
		<div className="flex h-7 items-center gap-2 text-small text-(--text-3)">
			<Spinner size={12} />
			{children}
		</div>
	);
}

function PullSection({ bounded, children }: { bounded: boolean; children: ReactNode }) {
	return <div className={cn(bounded && 'min-h-0 flex-1 overflow-y-auto')}>{children}</div>;
}

/** On a page of its own (`page`, as Reviews shows it) the page's bar already names the repository and links out, so the title leads. */
export function PullView({ sessionId, item, pulls, onSelect, ownWork, page = false }: { sessionId: string; item: PullRequestItem; pulls: PullRequestItem[]; onSelect: (number: number) => void; ownWork: boolean; page?: boolean }) {
	const [section, setSection] = useState<Section>('changes');
	const detail = useQuery({ queryKey: ['pull', sessionId, item.number], queryFn: () => api.pull(sessionId, item.number) });
	const pull = detail.data;
	const header = page ? (
		<div className="flex shrink-0 flex-col gap-2">
			<h2 className="m-0 text-h2 leading-[26px] font-semibold tracking-[-0.015em] text-pretty text-(--text)">{pull?.title ?? item.title}</h2>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-small text-(--text-3)">
				<StatePill state={pull?.state ?? item.state} size="sm" />
				<PullPicker pulls={pulls} selected={item} onSelect={onSelect} />
				{pull ? (
					<>
						<span className="text-(--text-2)">{pull.author}</span>
						<span className="flex min-w-0 items-center gap-1">
							<BranchChip name={pull.baseBranch} />
							<span aria-label="from">←</span>
							<BranchChip name={pull.headBranch} />
						</span>
						<span>opened {age(pull.createdAt)} ago</span>
						<span className="in-num whitespace-nowrap">
							{pull.changedFiles} {pull.changedFiles === 1 ? 'file' : 'files'} <span className="text-(--ok)">+{pull.additions}</span> <span className="text-(--bad)">−{pull.deletions}</span>
						</span>
					</>
				) : null}
			</div>
		</div>
	) : (
		<div className="flex min-w-0 shrink-0 items-center gap-1.5">
			<StatePill state={pull?.state ?? item.state} size="sm" />
			<PullPicker pulls={pulls} selected={item} onSelect={onSelect} />
			<span className="min-w-0 truncate text-small text-(--text-4)">{item.repo}</span>
			<span className="flex-1" />
			<a href={item.url} target="_blank" rel="noreferrer" className="sg-btn sg-btn--ghost sg-btn--xs shrink-0">
				<span>GitHub</span>
				<Icon icon={ArrowUpRight} size={12} />
			</a>
		</div>
	);
	if (detail.isError) {
		return (
			<div className="flex flex-col gap-3">
				{header}
				<EmptyState title="Pull request unavailable" body={detail.error.message} />
			</div>
		);
	}
	if (!pull) {
		return (
			<div className="flex flex-col gap-3">
				{header}
				<Loading>Reading #{item.number} from GitHub</Loading>
			</div>
		);
	}
	const sections: Array<{ id: Section; label: string; count?: number }> = [
		{ id: 'changes', label: 'Changes', count: pull.changedFiles },
		{ id: 'description', label: 'Description' },
		{ id: 'discussion', label: 'Discussion', count: pull.discussion.length },
		{ id: 'commits', label: 'Commits', count: pull.commits.length },
		{ id: 'checks', label: 'Checks', count: pull.checks.length },
	];
	return (
		<div className={cn('flex flex-col', page ? 'gap-4' : 'min-h-0 flex-1 gap-2.5')}>
			{header}
			{page ? null : (
				<div className="flex shrink-0 flex-col gap-1">
					<h2 className="m-0 text-body-lg leading-[20px] font-medium text-pretty text-(--text)">{pull.title}</h2>
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-(--text-3)">
						<span className="text-(--text-2)">{pull.author}</span>
						<span className="flex min-w-0 items-center gap-1">
							<BranchChip name={pull.baseBranch} />
							<span aria-label="from">←</span>
							<BranchChip name={pull.headBranch} />
						</span>
						<span>opened {age(pull.createdAt)} ago</span>
					</div>
				</div>
			)}
			<div className="shrink-0">
				<MergeBox sessionId={sessionId} pull={pull} ownWork={ownWork} />
			</div>
			<Segmented label="Pull request" className="max-w-full shrink-0 self-start overflow-x-auto">
				{sections.map((item) => (
					<SegmentedItem key={item.id} size="sm" className="shrink-0" on={section === item.id} onClick={() => setSection(item.id)}>
						{item.label}
						{item.count !== undefined ? <Count className="h-4 min-w-4 px-1">{item.count}</Count> : null}
					</SegmentedItem>
				))}
			</Segmented>
			{section === 'changes' ? (
					<PullChanges
						sessionId={sessionId}
						number={pull.number}
						bounded={!page}
						foreign={threadsOf(pull)}
					/>
				) : null}
			{section === 'description' ? (
				<PullSection bounded={!page}>
					{pull.body ? (
						<div className="in-well px-3.5 py-3 text-body text-(--text-2)">
							<Markdown text={pull.body} />
						</div>
					) : (
						<EmptyState title="No description" body="The pull request was opened without one." />
					)}
				</PullSection>
			) : null}
			{section === 'discussion' ? (
				<PullSection bounded={!page}>
					<Discussion
						pull={pull}
						onJump={(entry) => {
							setSection('changes');
							focusChange(sessionId, entry.path!, entry.line ?? undefined, entry.side);
						}}
					/>
				</PullSection>
			) : null}
			{section === 'commits' ? (
				<PullSection bounded={!page}>
					<Commits pull={pull} />
				</PullSection>
			) : null}
			{section === 'checks' ? (
				<PullSection bounded={!page}>
					<Checks pull={pull} />
				</PullSection>
			) : null}
		</div>
	);
}

export function PrTab({ sessionId }: { sessionId: string }) {
	const pulls = useQuery(taskQueries.pulls(sessionId));
	const session = useQuery(taskQueries.session(sessionId)).data;
	const [chosen, setChosen] = useState<number | null>(null);
	const list = pulls.data?.pulls ?? [];
	// A newer pull request opening while you look at the panel takes its place, unless you picked one.
	useEffect(() => {
		if (chosen !== null && !list.some((pull) => pull.number === chosen)) setChosen(null);
	}, [list, chosen]);
	if (pulls.isError) return <EmptyState title="Pull requests unavailable" body={pulls.error.message} />;
	if (!pulls.data) return <Loading>Loading pull requests</Loading>;
	if (list.length === 0) {
		return <EmptyState icon={GitPullRequest} title="No pull requests yet" body="When the agent opens one, it shows here with its checks, discussion and a Merge button." />;
	}
	const item = list.find((pull) => pull.number === chosen) ?? list.find((pull) => pull.current) ?? list[0];
	return <PullView key={item.url} sessionId={sessionId} item={item} pulls={list} onSelect={setChosen} ownWork={!session?.review} />;
}
