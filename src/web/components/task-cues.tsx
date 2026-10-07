import { Link } from '@tanstack/react-router';
import { ArrowUpRight, ClipboardList, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from 'lucide-react';
import { HoverCard } from 'radix-ui';
import type { ReactNode } from 'react';
import { Icon } from '@/components/signal';
import type { Session } from '@/lib/api';
import { planReady, prNumber } from '@/lib/task-view';
import { cn } from '@/lib/utils';

type PullRequest = NonNullable<Session['pullRequest']>;
type Checks = NonNullable<PullRequest['checks']>;

const PR: Record<PullRequest['state'], { icon: LucideIcon; label: string; className: string }> = {
	open: { icon: GitPullRequest, label: 'open', className: 'text-(--text-secondary)' },
	draft: { icon: GitPullRequestDraft, label: 'draft', className: 'text-(--text-tertiary)' },
	merged: { icon: GitMerge, label: 'merged', className: 'text-(--success-text)' },
	closed: { icon: GitPullRequestClosed, label: 'closed', className: 'text-(--text-tertiary)' },
};

const DOT: Record<Checks, string> = { failed: 'bg-(--danger-base)', pending: 'bg-(--warning-base)', passed: 'bg-(--success-base)' };
const CHECKS: Record<Checks, string> = { failed: 'failing', pending: 'running', passed: 'passing' };

const CUE = 'relative inline-flex shrink-0 items-center gap-1 rounded-sm outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)';

function Dot({ checks }: { checks: Checks }) {
	return <span className={cn('size-1.5 shrink-0 rounded-full', DOT[checks], checks === 'pending' && 'animate-pulse')} />;
}

/** Each check on the pull request's head commit, failing ones first. */
function ChecksCard({ number, pullRequest, url }: { number: string; pullRequest: PullRequest & { checks: Checks }; url: string }) {
	const order: Checks[] = ['failed', 'pending', 'passed'];
	const runs = [...pullRequest.runs].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
	const counts = order.flatMap((status) => {
		const count = runs.filter((run) => run.status === status).length;
		return count ? [`${count} ${CHECKS[status]}`] : [];
	});
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-[12px] font-medium text-(--text-primary)">Checks on {number}</span>
				<span className="text-[11px] text-(--text-tertiary)">{counts.join(', ') || CHECKS[pullRequest.checks]}</span>
			</div>
			{runs.length ? (
				<div className="-mx-1 flex max-h-[220px] flex-col overflow-y-auto">
					{runs.map((run) => (
						<a
							key={`${run.name}-${run.url}`}
							href={run.url || url}
							target="_blank"
							rel="noreferrer"
							className="flex h-6 items-center gap-2 rounded-md px-1 text-[12px] text-(--text-secondary) outline-none hover:bg-(--bg-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
						>
							<Dot checks={run.status} />
							<span className="min-w-0 flex-1 truncate">{run.name}</span>
						</a>
					))}
				</div>
			) : null}
			<a
				href={url}
				target="_blank"
				rel="noreferrer"
				className="inline-flex items-center gap-1 self-start text-[12px] text-(--text-tertiary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)"
			>
				Open checks on GitHub
				<Icon icon={ArrowUpRight} size={11} />
			</a>
		</div>
	);
}

/** "CI" with a dot in the colour of its checks; links to them, and resting on it lists each one. */
function CiCue({ number, pullRequest, prUrl, onCardChange }: { number: string; pullRequest: PullRequest & { checks: Checks }; prUrl: string; onCardChange: (open: boolean) => void }) {
	const url = `${prUrl}/checks`;
	return (
		<HoverCard.Root openDelay={250} closeDelay={120} onOpenChange={onCardChange}>
			<HoverCard.Trigger asChild>
				<a href={url} target="_blank" rel="noreferrer" aria-label={`Checks ${CHECKS[pullRequest.checks]} on ${number}`} className={CUE}>
					<Dot checks={pullRequest.checks} />
					CI
				</a>
			</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					side="right"
					align="start"
					sideOffset={12}
					collisionPadding={12}
					className="z-50 w-[260px] rounded-xl bg-(--bg-overlay) p-3 shadow-(--shadow-overlay) outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
				>
					<ChecksCard number={number} pullRequest={pullRequest} url={url} />
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

/**
 * The few things worth acting on from the sidebar, each a link: the pull request by number,
 * its CI, and a plan waiting for review. `onCardChange` tells the row while the CI card is open.
 */
export function TaskCues({ session, onCardChange }: { session: Session; onCardChange: (open: boolean) => void }) {
	const cues: ReactNode[] = [];
	if (planReady(session)) {
		cues.push(
			<Link key="plan" to="/agents/$sessionId" params={{ sessionId: session.id }} search={{ app: 'code' }} className={cn(CUE, 'text-(--warning-text)')}>
				<Icon icon={ClipboardList} size={11} />
				Review plan
			</Link>,
		);
	}
	const pullRequest = session.pullRequest;
	if (session.prUrl) {
		const number = `#${prNumber(session) ?? '?'}`;
		const pr = PR[pullRequest?.state ?? 'open'];
		cues.push(
			<a key="pr" href={session.prUrl} target="_blank" rel="noreferrer" aria-label={`Pull request ${number}, ${pr.label}`} className={cn(CUE, pr.className)}>
				<Icon icon={pr.icon} size={11} />
				<span className="tabular-nums">{number}</span>
			</a>,
		);
		if (pullRequest?.checks) cues.push(<CiCue key="ci" number={number} pullRequest={{ ...pullRequest, checks: pullRequest.checks }} prUrl={session.prUrl} onCardChange={onCardChange} />);
	}
	return cues.length ? <span className="flex shrink-0 items-center gap-2">{cues}</span> : null;
}
