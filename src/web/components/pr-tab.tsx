import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Check, ChevronDown, CircleAlert, CircleCheck, CircleDot, CircleX, Copy, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, MessageSquare } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { DiffList } from '@/components/git-tab';
import { Count, Segmented, SegmentedItem } from '@/components/instrument';
import { Markdown } from '@/components/markdown';
import { prColor } from '@/components/pr-status';
import { Btn, DiffStat, EmptyState, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Spinner } from '@/components/signal';
import { api, type CheckRun, type PullRequestDetail, type PullRequestItem, type PullRequestState } from '@/lib/api';
import { parsePatch } from '@/lib/diff';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATE_LABEL: Record<PullRequestState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const STATE_ICON = { open: GitPullRequest, draft: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed } as const;

/** The pull request's state as GitHub shows it: a coloured pill with its icon. */
function StatePill({ state, size = 'md' }: { state: PullRequestState | null; size?: 'sm' | 'md' }) {
	const color = prColor(state);
	return (
		<span
			className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border font-medium whitespace-nowrap', size === 'md' ? 'h-6 px-2.5 text-[12px]' : 'h-5 px-1.5 text-[11px]')}
			style={{ color, borderColor: `color-mix(in oklab, ${color} 32%, transparent)`, background: `color-mix(in oklab, ${color} 12%, transparent)` }}
		>
			<Icon icon={STATE_ICON[state ?? 'open']} size={size === 'md' ? 13 : 11} />
			{state ? STATE_LABEL[state] : 'Unknown'}
		</span>
	);
}

/** A branch name in a chip you can copy from. */
function BranchChip({ name }: { name: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span className="inline-flex h-5 min-w-0 items-center gap-1 rounded-md bg-(--alpha-white-6) pr-0.5 pl-1.5 font-mono text-[11px] text-(--text-secondary)">
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
				className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-(--icon-tertiary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
			>
				<Icon icon={copied ? Check : Copy} size={10} />
			</button>
		</span>
	);
}

/** Picks one of the task's pull requests; the newest is shown first. */
function PullPicker({ pulls, selected, onSelect }: { pulls: PullRequestItem[]; selected: PullRequestItem; onSelect: (number: number) => void }) {
	if (pulls.length < 2) return null;
	return (
		<Menu>
			<MenuTrigger asChild>
				<Btn size="xs" variant="ghost" className="min-w-0">
					<span className="truncate">
						#{selected.number} of {pulls.length} pull requests
					</span>
					<Icon icon={ChevronDown} size={12} />
				</Btn>
			</MenuTrigger>
			<MenuContent align="start" className="w-[320px]">
				<MenuLabel>Pull requests in this thread</MenuLabel>
				{pulls.map((pull) => (
					<MenuItem key={pull.url} checked={pull.number === selected.number} onSelect={() => onSelect(pull.number)} hint={age(pull.openedAt)}>
						<span className="flex min-w-0 items-center gap-2">
							<span className="inline-flex shrink-0" style={{ color: prColor(pull.state) }}>
								<Icon icon={STATE_ICON[pull.state ?? 'open']} size={12} />
							</span>
							<span className="in-num shrink-0 text-(--text-tertiary)">#{pull.number}</span>
							<span className="truncate">{pull.title}</span>
						</span>
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}

const CHECK_ICON = { passed: CircleCheck, failed: CircleX, pending: CircleDot, skipped: CircleDot } as const;
const CHECK_TONE = { passed: 'text-(--success-text)', failed: 'text-(--danger-text)', pending: 'text-(--warning-text)', skipped: 'text-(--text-disabled)' } as const;

/** Checks in a phrase: "2 failing, 5 passing". */
function checksPhrase(checks: CheckRun[]): string {
	const count = (status: CheckRun['status']) => checks.filter((check) => check.status === status).length;
	const parts = [
		count('failed') ? `${count('failed')} failing` : null,
		count('pending') ? `${count('pending')} running` : null,
		count('passed') ? `${count('passed')} passing` : null,
	].filter(Boolean);
	return parts.length ? parts.join(', ') : 'No checks';
}

/**
 * Where the pull request stands for merging, and the Merge button: squash,
 * by default, after a second click, since a merge cannot be undone.
 */
function MergeBox({ sessionId, pull, ownWork }: { sessionId: string; pull: PullRequestDetail; ownWork: boolean }) {
	const queryClient = useQueryClient();
	const [method, setMethod] = useState<'squash' | 'merge' | 'rebase'>('squash');
	const [confirming, setConfirming] = useState(false);
	const merge = useMutation({
		mutationFn: () => api.mergePull(sessionId, pull.number, { method, sha: pull.headSha }),
		onSuccess: (merged) => {
			setConfirming(false);
			queryClient.setQueryData(['pull', sessionId, pull.number], merged);
			void queryClient.invalidateQueries({ queryKey: ['pulls', sessionId] });
			void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
			void queryClient.invalidateQueries({ queryKey: ['changes', sessionId] });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
	});
	if (pull.state === 'merged') {
		return (
			<Box tone="merged" icon={GitMerge} title={`Merged${pull.mergedBy ? ` by ${pull.mergedBy}` : ''}${pull.mergedAt ? ` ${age(pull.mergedAt)} ago` : ''}`}>
				{pull.headBranch} went into {pull.baseBranch}.
			</Box>
		);
	}
	if (pull.state === 'closed') {
		return (
			<Box tone="closed" icon={GitPullRequestClosed} title="Closed without merging">
				{pull.closedAt ? `Closed ${age(pull.closedAt)} ago.` : 'It was closed on GitHub.'}
			</Box>
		);
	}
	const failing = pull.checks.some((check) => check.status === 'failed');
	const running = pull.checks.some((check) => check.status === 'pending');
	const blocked = pull.draft ? 'A draft cannot be merged; mark it ready on GitHub first.' : pull.mergeable === false ? `It has conflicts with ${pull.baseBranch}; ask the agent to fix them.` : !ownWork ? "This thread reviews someone else's pull request; merge it on GitHub." : null;
	const label = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' }[method];
	return (
		<Box
			tone={blocked || failing ? 'warning' : 'ready'}
			icon={blocked || failing ? CircleAlert : running ? CircleDot : CircleCheck}
			title={blocked ? 'Not ready to merge' : failing ? 'Checks are failing' : running ? 'Checks are running' : 'Ready to merge'}
			action={
				<div className="flex shrink-0 items-center">
					<Btn
						size="sm"
						variant={confirming ? 'primary' : 'secondary'}
						icon={GitMerge}
						disabled={Boolean(blocked) || merge.isPending}
						onClick={() => (confirming ? merge.mutate() : setConfirming(true))}
						onBlur={() => setConfirming(false)}
						className="rounded-r-none"
					>
						{merge.isPending ? 'Merging…' : confirming ? 'Click again to merge' : label}
					</Btn>
					<Menu>
						<MenuTrigger asChild>
							<IconBtn icon={ChevronDown} size="sm" variant="secondary" label="Merge method" disabled={Boolean(blocked) || merge.isPending} className="rounded-l-none border-l-0" />
						</MenuTrigger>
						<MenuContent align="end" className="w-[240px]">
							<MenuLabel>Merge method</MenuLabel>
							<MenuItem checked={method === 'squash'} onSelect={() => setMethod('squash')}>
								Squash and merge
							</MenuItem>
							<MenuItem checked={method === 'merge'} onSelect={() => setMethod('merge')}>
								Create a merge commit
							</MenuItem>
							<MenuItem checked={method === 'rebase'} onSelect={() => setMethod('rebase')}>
								Rebase and merge
							</MenuItem>
						</MenuContent>
					</Menu>
				</div>
			}
		>
			{merge.isError ? (
				<span className="text-(--danger-text)">{merge.error.message}</span>
			) : (
				<>
					{blocked ?? checksPhrase(pull.checks)}
					{pull.approved ? ' · Approved' : ''}
				</>
			)}
		</Box>
	);
}

const BOX_TONE = {
	ready: 'var(--success-text)',
	warning: 'var(--warning-text)',
	merged: 'var(--data-2)',
	closed: 'var(--danger-text)',
} as const;

function Box({ tone, icon, title, action, children }: { tone: keyof typeof BOX_TONE; icon: typeof GitMerge; title: string; action?: ReactNode; children: ReactNode }) {
	return (
		<div className="in-card flex-row flex-wrap items-center gap-3 px-3.5 py-3" style={{ boxShadow: `inset 3px 0 0 ${BOX_TONE[tone]}` }}>
			<span className="inline-flex shrink-0" style={{ color: BOX_TONE[tone] }}>
				<Icon icon={icon} size={16} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-[13px] font-medium text-(--text-primary)">{title}</span>
				<span className="text-[12px] text-(--text-tertiary)">{children}</span>
			</div>
			{action}
		</div>
	);
}

type Section = 'changes' | 'description' | 'discussion' | 'commits' | 'checks';

function PullChanges({ sessionId, number }: { sessionId: string; number: number }) {
	const diff = useQuery({ queryKey: ['pull', sessionId, number, 'diff'], queryFn: () => api.pullDiff(sessionId, number), staleTime: 60_000 });
	const files = useMemo(() => (diff.data ? parsePatch(diff.data.patch) : []), [diff.data]);
	if (diff.isError) return <EmptyState title="Diff unavailable" body={diff.error.message} />;
	if (!diff.data) return <Loading>Reading the diff from GitHub</Loading>;
	return <DiffList files={files} empty="This pull request changes no files." />;
}

function Discussion({ pull }: { pull: PullRequestDetail }) {
	if (pull.discussion.length === 0) return <EmptyState icon={MessageSquare} title="No discussion yet" body="Comments and reviews on GitHub show up here." />;
	return (
		<ol className="m-0 flex list-none flex-col gap-2 p-0">
			{pull.discussion.map((entry) => (
				<li key={entry.id} className="in-card gap-1.5 px-3.5 py-3">
					<div className="flex flex-wrap items-center gap-2 text-[12px]">
						<span className="font-medium text-(--text-primary)">{entry.author}</span>
						<span className="text-(--text-tertiary)">{entry.kind === 'review' ? 'reviewed' : entry.kind === 'line' ? 'commented on a line' : 'commented'}</span>
						{entry.verdict ? (
							<span className={cn('rounded-md px-1.5 py-px text-[11px]', entry.verdict === 'approved' ? 'bg-(--success-bg) text-(--success-text)' : 'bg-(--warning-bg) text-(--warning-text)')}>{entry.verdict}</span>
						) : null}
						{entry.path ? (
							<span className="truncate font-mono text-[11px] text-(--text-tertiary)">
								{entry.path}
								{entry.line ? `:${entry.line}` : ''}
							</span>
						) : null}
						<span className="flex-1" />
						<span className="in-num text-[11px] text-(--text-disabled)">{entry.at ? age(entry.at) : ''}</span>
					</div>
					{entry.body ? (
						<div className="text-[13px] text-(--text-secondary)">
							<Markdown text={entry.body} />
						</div>
					) : null}
				</li>
			))}
		</ol>
	);
}

function Commits({ pull }: { pull: PullRequestDetail }) {
	if (pull.commits.length === 0) return <EmptyState icon={GitCommitHorizontal} title="No commits" />;
	return (
		<ol className="in-card m-0 list-none p-1.5">
			{pull.commits.map((commit) => (
				<li key={commit.sha} className="flex min-h-10 items-center gap-3 rounded-lg px-2.5 hover:bg-(--bg-hover)">
					<Icon icon={GitCommitHorizontal} size={13} className="shrink-0 text-(--icon-tertiary)" />
					<span className="min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)">{commit.subject}</span>
					<span className="in-num shrink-0 rounded-md bg-(--alpha-white-6) px-1.5 py-px text-[10.5px] text-(--text-tertiary)">{commit.sha.slice(0, 7)}</span>
				</li>
			))}
		</ol>
	);
}

function Checks({ pull }: { pull: PullRequestDetail }) {
	if (pull.checks.length === 0) return <EmptyState icon={CircleCheck} title="No checks" body="This repository runs no checks on the pull request's head." />;
	return (
		<ol className="in-card m-0 list-none p-1.5">
			{pull.checks.map((check, index) => (
				<li key={`${check.name}-${index}`} className="flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 hover:bg-(--bg-hover)">
					<Icon icon={CHECK_ICON[check.status]} size={14} className={cn('shrink-0', CHECK_TONE[check.status])} />
					<span className="shrink-0 text-[12.5px] text-(--text-primary)">{check.name}</span>
					<span className="min-w-0 flex-1 truncate text-[12px] text-(--text-tertiary)">{check.summary}</span>
					{check.url ? (
						<a href={check.url} target="_blank" rel="noreferrer" className="shrink-0 text-[12px] text-(--accent-text) underline-offset-2 hover:underline">
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
		<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
			<Spinner size={12} />
			{children}
		</div>
	);
}

function PullView({ sessionId, item, pulls, onSelect, ownWork }: { sessionId: string; item: PullRequestItem; pulls: PullRequestItem[]; onSelect: (number: number) => void; ownWork: boolean }) {
	const [section, setSection] = useState<Section>('changes');
	const detail = useQuery({ queryKey: ['pull', sessionId, item.number], queryFn: () => api.pull(sessionId, item.number) });
	const pull = detail.data;
	const header = (
		<div className="flex items-center gap-2">
			<StatePill state={pull?.state ?? item.state} />
			<PullPicker pulls={pulls} selected={item} onSelect={onSelect} />
			<span className="flex-1" />
			<a href={item.url} target="_blank" rel="noreferrer" className="sg-btn sg-btn--ghost sg-btn--xs">
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
		<div className="flex flex-col gap-3">
			{header}
			<div className="flex flex-col gap-1.5">
				<span className="in-num text-[12px] text-(--text-tertiary)">
					{pull.repo} · #{pull.number}
				</span>
				<h2 className="m-0 text-[16px] leading-[22px] font-medium text-pretty text-(--text-primary)">{pull.title}</h2>
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-(--text-tertiary)">
					<span className="text-(--text-secondary)">{pull.author}</span>
					<span className="flex min-w-0 items-center gap-1">
						<BranchChip name={pull.baseBranch} />
						<span aria-label="from">←</span>
						<BranchChip name={pull.headBranch} />
					</span>
					<span>Opened {age(pull.createdAt)} ago</span>
					<span>
						{pull.changedFiles} {pull.changedFiles === 1 ? 'file' : 'files'}
					</span>
					<span className="in-num">
						<DiffStat added={pull.additions} removed={pull.deletions} />
					</span>
				</div>
			</div>
			<MergeBox sessionId={sessionId} pull={pull} ownWork={ownWork} />
			<Segmented label="Pull request" className="max-w-full self-start overflow-x-auto">
				{sections.map((item) => (
					<SegmentedItem key={item.id} size="sm" on={section === item.id} onClick={() => setSection(item.id)}>
						{item.label}
						{item.count !== undefined ? <Count className="h-4 min-w-4 px-1">{item.count}</Count> : null}
					</SegmentedItem>
				))}
			</Segmented>
			{section === 'changes' ? <PullChanges sessionId={sessionId} number={pull.number} /> : null}
			{section === 'description' ? (
				pull.body ? (
					<div className="in-card px-4 py-3 text-[13px] text-(--text-secondary)">
						<Markdown text={pull.body} />
					</div>
				) : (
					<EmptyState title="No description" body="The pull request was opened without one." />
				)
			) : null}
			{section === 'discussion' ? <Discussion pull={pull} /> : null}
			{section === 'commits' ? <Commits pull={pull} /> : null}
			{section === 'checks' ? <Checks pull={pull} /> : null}
		</div>
	);
}

/**
 * The PR panel: the pull requests the task opened, newest first, each as
 * GitHub's page shows it (state, branches, checks, discussion, commits and
 * its diff), with a Merge button that squashes by default.
 */
export function PrTab({ sessionId }: { sessionId: string }) {
	const pulls = useQuery({ queryKey: ['pulls', sessionId], queryFn: () => api.pulls(sessionId) });
	const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) }).data;
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
