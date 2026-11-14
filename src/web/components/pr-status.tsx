import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, CircleX, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '@/components/signal';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, type Session } from '@/lib/api';
import { cn } from '@/lib/utils';

type State = NonNullable<Session['pullRequest']>['state'];
export const prNumber = (url: string | null) => url ? (/\/pull\/(\d+)/.exec(url)?.[1] ?? null) : null;

/**
 * One colour per thing a pull request can be, the same everywhere it shows
 * (chips, rows, the PR tab, Reviews, Home): open green, draft grey, merged
 * violet, closed red, conflicts orange, and checks passed green, running
 * amber, failing red. Each is a state hue of `styles/aura-tokens.css` with
 * its soft fill behind it.
 */
export type PrTone = 'open' | 'draft' | 'merged' | 'closed' | 'conflicts' | 'passed' | 'running' | 'failing' | 'unknown';
const PR_HUE: Record<PrTone, [color: string, soft: string]> = {
	open: ['var(--ok)', 'var(--ok-soft)'],
	draft: ['var(--text-2)', 'var(--bg-active)'],
	merged: ['var(--merged)', 'var(--merged-soft)'],
	closed: ['var(--bad)', 'var(--bad-soft)'],
	conflicts: ['var(--conflict)', 'var(--conflict-soft)'],
	passed: ['var(--ok)', 'var(--ok-soft)'],
	running: ['var(--warn)', 'var(--warn-soft)'],
	failing: ['var(--bad)', 'var(--bad-soft)'],
	unknown: ['var(--text-3)', 'var(--bg-active)'],
};
export const prTone = (tone: PrTone) => PR_HUE[tone][0];
export const prColor = (state?: State | null) => prTone(state ?? 'unknown');
export const checksTone = (checks: 'passed' | 'pending' | 'failed'): PrTone => ({ passed: 'passed', pending: 'running', failed: 'failing' } as const)[checks];
export const PR_ICON: Record<State, LucideIcon> = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed };

/** A badge tinted in a PR tone: its text in the colour, on the soft fill of it. */
export const prChipStyle = (tone: PrTone): CSSProperties => ({ color: PR_HUE[tone][0], background: PR_HUE[tone][1] });

/** The shape every PR badge takes: 18px tall, a 4px corner, 11px medium. */
const PR_BADGE = 'inline-flex h-[18px] shrink-0 items-center gap-1 rounded-inner px-1.5 text-micro leading-none font-medium whitespace-nowrap';

/** A short PR word on a row (Conflicts, Draft, Checks failing), tinted in its tone. */
export function PrFlag({ tone, children, className }: { tone: PrTone; children: ReactNode; className?: string }) {
	return <span className={cn(PR_BADGE, className)} style={prChipStyle(tone)}>{children}</span>;
}

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
	const content = <><Icon icon={PR_ICON[pr?.state ?? 'open']} size={11} /><span>{visible}</span>{!full && active && showConflicts && pr.conflicts ? <span style={{ color: prTone('conflicts') }}>Conflicts</span> : null}{!full && active && showFailing && pr.checks === 'failed' ? <span style={{ color: prTone('failing') }}>Checks failing</span> : null}</>;
	const props = { title: summary, 'aria-label': `Pull request ${summary}`, className: cn('in-num outline-none focus-visible:shadow-(--focus)', PR_BADGE, link && 'hover:brightness-125', className), style: prChipStyle(pr?.state ?? 'unknown') };
	return link ? <a {...props} href={thread.prUrl} target="_blank" rel="noreferrer">{content}</a> : <span {...props}>{content}</span>;
}

/** Focusable text, not a button: inspecting a branch does not perform an action. */
function BranchName({ name, kind }: { name: string; kind: 'Source' | 'Target' }) {
	return <Tooltip>
		<TooltipTrigger asChild><span tabIndex={0} aria-label={`${kind} branch: ${name}`} className="min-w-0 truncate rounded-mark focus-visible:shadow-(--focus)">{name}</span></TooltipTrigger>
		<TooltipContent sideOffset={5} className="z-[60] max-w-[min(24rem,calc(100vw-24px))] break-all">{name}</TooltipContent>
	</Tooltip>;
}

/** Branches and diff come from the host for this exact PR, including older PRs.
 * Compact is for constrained metadata rows outside links; its branches are focusable.
 */
export function PrMetadata({ sessionId, url, enabled = true, compact = false }: { sessionId: string; url: string; enabled?: boolean; compact?: boolean }) {
	const number = Number(prNumber(url));
	const detail = useQuery({ queryKey: ['pr-metadata', sessionId, number], queryFn: () => api.pullMetadata(sessionId, number), enabled: enabled && number > 0, staleTime: 60_000, retry: false }).data;
	if (!detail || detail.url !== url) return null;
	return (
		<span className={cn('inline-flex min-w-0 items-center gap-x-2 gap-y-1 text-small leading-[16px] text-(--text-3)', compact ? 'flex-1' : 'flex-wrap')}>
			{compact ? (
				// Intrinsic tracks let a short branch keep its natural width while the
				// longer branch uses the remaining space; both can still truncate.
				<span className="grid min-w-0 flex-1 grid-cols-[minmax(0,max-content)_max-content_minmax(0,max-content)] items-center gap-1">
					<BranchName name={detail.headBranch || 'Unknown source'} kind="Source" />
					<span aria-hidden="true">→</span>
					<BranchName name={detail.baseBranch || 'Unknown target'} kind="Target" />
				</span>
			) : <span className="inline-flex min-w-0 items-center gap-1" title={`${detail.headBranch} → ${detail.baseBranch}`}><Icon icon={GitBranch} size={11} /><span className="truncate">{detail.headBranch} → {detail.baseBranch}</span></span>}
			<span className="in-num shrink-0 whitespace-nowrap" aria-label={`${detail.additions} additions, ${detail.deletions} deletions`}><span className="text-(--ok)">+{detail.additions}</span> <span className="text-(--bad)">−{detail.deletions}</span></span>
		</span>
	);
}

/** Checks are a separate status, never part of the PR identity or shown after merge. */
export function PrChecks({ pull }: { pull: Session['pullRequest'] }) {
	if ((pull?.state !== 'open' && pull?.state !== 'draft') || !pull.checks) return null;
	const checks = {
		passed: { icon: CircleCheck, label: 'Checks passed' },
		failed: { icon: CircleX, label: 'Checks failing' },
		pending: { icon: CircleDashed, label: 'Checks running' },
	} as const;
	const check = checks[pull.checks];
	const failing = pull.runs.filter((run) => run.status === 'failed').length;
	return <span className="inline-flex shrink-0 items-center gap-1 text-small" style={{ color: prTone(checksTone(pull.checks)) }}><Icon icon={check.icon} size={11} />{failing ? `${failing} failing` : check.label}</span>;
}
