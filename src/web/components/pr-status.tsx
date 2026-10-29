import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, CircleX, GitBranch, GitMerge, GitPullRequest } from 'lucide-react';
import { Icon } from '@/components/signal';
import { api, type Session } from '@/lib/api';
import { cn } from '@/lib/utils';

type State = NonNullable<Session['pullRequest']>['state'];
export const prNumber = (url: string | null) => url ? (/\/pull\/(\d+)/.exec(url)?.[1] ?? null) : null;
export const prColor = (state?: State | null) => (state ? { open: 'var(--success-text)', merged: 'var(--data-2)', draft: 'var(--text-tertiary)', closed: 'var(--danger-text)' }[state] : 'var(--text-tertiary)');

/** State remains visible even when checks or conflicts need attention. */
export function prSummary(thread: Pick<Session, 'prUrl' | 'pullRequest'>): string | null {
	if (!thread.prUrl) return null;
	const pr = thread.pullRequest;
	const name = `#${prNumber(thread.prUrl) ?? '?'}`;
	if (!pr) return `${name} · status unknown`;
	const details = pr.state === 'merged' || pr.state === 'closed' ? [] : [pr.conflicts ? 'merge conflicts' : null, pr.checks === 'failed' ? 'checks failing' : pr.checks === 'pending' ? 'checks running' : pr.checks === 'passed' ? 'checks pass' : null, pr.approved ? 'approved' : null].filter(Boolean);
	return `${name} ${pr.state}${details.length ? ` · ${details.join(' · ')}` : ''}`;
}

/** Compact, consistent PR identity; link only where it is not inside another interactive control. */
export function PrStatus({ thread, link = false, full = false, showConflicts = true, showFailing = true, className }: { thread: Pick<Session, 'prUrl' | 'pullRequest'>; link?: boolean; full?: boolean; showConflicts?: boolean; showFailing?: boolean; className?: string }) {
	if (!thread.prUrl) return null;
	const summary = prSummary(thread)!;
	const pr = thread.pullRequest;
	const active = pr && (pr.state === 'open' || pr.state === 'draft');
	const visible = full && pr?.state !== 'merged' ? summary : `#${prNumber(thread.prUrl) ?? '?'}`;
	const content = <><Icon icon={pr?.state === 'merged' ? GitMerge : GitPullRequest} size={12} /><span>{visible}</span>{!full && active && showConflicts && pr.conflicts ? <span className="text-(--warning-text)">Conflicts</span> : null}{!full && active && showFailing && pr.checks === 'failed' ? <span className="text-(--danger-text)">Checks failing</span> : null}</>;
	const props = { title: summary, 'aria-label': `Pull request ${summary}`, className: cn('in-num inline-flex h-5 shrink-0 items-center gap-1 rounded-[6px] border px-1.5 text-[11px] leading-none whitespace-nowrap outline-none focus-visible:shadow-(--focus-ring)', link && 'hover:brightness-125', className), style: { color: prColor(pr?.state), borderColor: `color-mix(in oklab, ${prColor(pr?.state)} 32%, transparent)`, background: `color-mix(in oklab, ${prColor(pr?.state)} 10%, transparent)` } };
	return link ? <a {...props} href={thread.prUrl} target="_blank" rel="noreferrer">{content}</a> : <span {...props}>{content}</span>;
}

/** Branches and diff come from the host for this exact PR, including older PRs. */
export function PrMetadata({ sessionId, url, enabled = true }: { sessionId: string; url: string; enabled?: boolean }) {
	const number = Number(prNumber(url));
	const detail = useQuery({ queryKey: ['pull', sessionId, number], queryFn: () => api.pull(sessionId, number), enabled: enabled && number > 0, staleTime: 60_000, retry: false }).data;
	if (!detail || detail.url !== url) return null;
	return (
		<span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] leading-[16px] text-(--text-tertiary)">
			<span className="inline-flex min-w-0 items-center gap-1" title={`${detail.headBranch} → ${detail.baseBranch}`}><Icon icon={GitBranch} size={11} /><span className="truncate">{detail.headBranch} → {detail.baseBranch}</span></span>
			<span className="in-num whitespace-nowrap" aria-label={`${detail.additions} additions, ${detail.deletions} deletions`}><span className="text-(--success-text)">+{detail.additions}</span> <span className="text-(--danger-text)">−{detail.deletions}</span></span>
		</span>
	);
}

/** Checks are a separate status, never part of the PR identity or shown after merge. */
export function PrChecks({ pull }: { pull: Session['pullRequest'] }) {
	if (pull?.state !== 'open' || !pull.checks) return null;
	const checks = {
		passed: { icon: CircleCheck, label: 'Checks passed', tone: 'text-(--success-text)' },
		failed: { icon: CircleX, label: 'Checks failing', tone: 'text-(--danger-text)' },
		pending: { icon: CircleDashed, label: 'Checks running', tone: 'text-(--warning-text)' },
	} as const;
	const check = checks[pull.checks];
	const failing = pull.runs.filter((run) => run.status === 'failed').length;
	return <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11.5px]', check.tone)}><Icon icon={check.icon} size={11} />{failing ? `${failing} failing` : check.label}</span>;
}
