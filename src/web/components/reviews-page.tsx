import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ExternalLink, GitPullRequest, MessageSquare } from 'lucide-react';
import { PageFrame } from '@/components/page-frame';
import { Badge, EmptyState, Icon, IconBtn, SectionLabel, Spinner } from '@/components/signal';
import { api, type ReviewGroup, type ReviewItem } from '@/lib/api';
import { age } from '@/lib/format';

const GROUPS: Record<ReviewGroup, { label: string; help: string }> = {
	ready: { label: 'Waiting on you', help: 'Checks passed or there are none. Review and merge on GitHub.' },
	failing: { label: 'Failing checks', help: 'Anton sends failed checks to the agent, unless follow-ups are off for the repository.' },
	checking: { label: 'Checks running', help: 'Waiting on CI.' },
	unknown: { label: 'Could not check', help: 'GitHub did not answer for these.' },
	merged: { label: 'Merged', help: '' },
	closed: { label: 'Closed', help: '' },
};

const number = (url: string) => url.match(/\/pull\/(\d+)/)?.[1];

function checksText({ passed, failed, pending }: ReviewItem['checks']): string {
	const parts = [failed && `${failed} failed`, pending && `${pending} running`, passed && `${passed} passed`].filter(Boolean);
	return parts.length ? parts.join(', ') : 'no checks';
}

function Row({ item }: { item: ReviewItem }) {
	const open = item.group !== 'merged' && item.group !== 'closed';
	return (
		<div className="flex min-h-12 items-center gap-3 rounded-lg px-2.5 py-1.5 hover:bg-(--bg-hover)">
			<Icon icon={GitPullRequest} className={open ? 'text-(--accent-text)' : 'text-(--icon-tertiary)'} />
			<Link
				to="/agents/$sessionId"
				params={{ sessionId: item.sessionId }}
				search={{ app: 'code' }}
				className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md outline-none focus-visible:shadow-(--focus-ring)"
			>
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-[13px] font-medium">{item.title}</span>
					{item.draft ? <Badge>Draft</Badge> : null}
				</div>
				<div className="truncate text-[12px] text-(--text-tertiary)">
					{item.repo} #{number(item.url)} · {age(item.createdAt)}
					{open ? ` · ${checksText(item.checks)}` : ''}
				</div>
			</Link>
			{open && item.comments ? (
				<span className="flex shrink-0 items-center gap-1 text-[12px] text-(--text-tertiary)" title="Comments and reviews">
					<Icon icon={MessageSquare} size={12} />
					{item.comments}
				</span>
			) : null}
			<IconBtn icon={ExternalLink} size="sm" label="Open on GitHub" onClick={() => window.open(item.url, '_blank', 'noopener')} />
		</div>
	);
}

/** Pull requests the agent opened, grouped by what each waits on. */
export function ReviewsPage() {
	// Pull request state lives on GitHub, which tells Anton nothing, so this asks again every few minutes.
	const reviews = useQuery({ queryKey: ['reviews'], queryFn: api.reviews, refetchInterval: 5 * 60_000 });
	const items = reviews.data?.reviews ?? [];
	const groups = (Object.keys(GROUPS) as ReviewGroup[])
		.map((group) => ({ group, items: items.filter((item) => item.group === group) }))
		.filter((entry) => entry.items.length > 0);
	return (
		<PageFrame title="Reviews">
			{reviews.isPending ? (
				<Spinner size={12} />
			) : reviews.isError ? (
				<p className="m-0 text-[12px] text-(--danger-text)">Could not load pull requests: {reviews.error.message}</p>
			) : groups.length === 0 ? (
				<EmptyState icon={GitPullRequest} title="No pull requests yet" body="Pull requests the agent opens show up here, with their checks and comments." />
			) : (
				groups.map(({ group, items }) => (
					<section key={group} className="flex flex-col gap-1.5">
						<div className="flex items-baseline gap-2 px-1">
							<SectionLabel>{GROUPS[group].label}</SectionLabel>
							<span className="text-[11px] text-(--text-disabled)">{items.length}</span>
						</div>
						{GROUPS[group].help ? <p className="m-0 px-1 text-[12px] text-(--text-tertiary)">{GROUPS[group].help}</p> : null}
						<div className="flex flex-col gap-0.5 rounded-lg border border-(--border-subtle) bg-(--bg-surface) p-1">
							{items.map((item) => (
								<Row key={item.sessionId} item={item} />
							))}
						</div>
					</section>
				))
			)}
		</PageFrame>
	);
}
