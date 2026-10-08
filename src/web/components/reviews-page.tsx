import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ExternalLink, GitMerge, GitPullRequest, MessageSquare } from 'lucide-react';
import { BranchArt } from '@/components/illustrations';
import { Card, CardSection, Figure, Pips, SplitBar, StatRow, Status, type Tone, Well } from '@/components/instrument';
import { PageFrame } from '@/components/page-frame';
import { Badge, Icon, IconBtn, Spinner } from '@/components/signal';
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

const GROUP_TONE: Record<ReviewGroup, Tone> = { ready: 'success', failing: 'danger', checking: 'warning', unknown: 'neutral', merged: 'accent', closed: 'neutral' };
const GROUP_COLOR: Record<ReviewGroup, string> = {
	ready: 'var(--success-base)',
	failing: 'var(--danger-base)',
	checking: 'var(--warning-base)',
	unknown: 'var(--neutral-500)',
	merged: 'var(--data-2)',
	closed: 'var(--neutral-600)',
};
const SHORT: Record<ReviewGroup, string> = { ready: 'Ready', failing: 'Failing', checking: 'Running', unknown: 'Unknown', merged: 'Merged', closed: 'Closed' };

/** One pip per check, failures first, so a row shows its CI at a glance. */
function CheckPips({ checks }: { checks: ReviewItem['checks'] }) {
	const items = [
		...Array.from({ length: checks.failed }, () => ({ tone: 'danger' as const, title: 'Failed' })),
		...Array.from({ length: checks.pending }, () => ({ tone: 'warning' as const, title: 'Running' })),
		...Array.from({ length: checks.passed }, () => ({ tone: 'success' as const, title: 'Passed' })),
	].slice(0, 12);
	if (!items.length) return null;
	return <Pips items={items} label={checksText(checks)} />;
}

function Row({ item }: { item: ReviewItem }) {
	const open = item.group !== 'merged' && item.group !== 'closed';
	return (
		<div className="flex min-h-[52px] items-center gap-3 rounded-[10px] px-2 py-1.5 hover:bg-(--bg-hover)">
			<span
				className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-(--border-subtle) bg-(--well-bg)"
				style={{ color: open ? GROUP_COLOR[item.group] : 'var(--icon-tertiary)' }}
			>
				<Icon icon={item.group === 'merged' ? GitMerge : GitPullRequest} size={13} />
			</span>
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
				<div className="truncate font-mono text-[11px] text-(--text-tertiary)">
					{item.repo} #{number(item.url)} · {age(item.createdAt)}
					{open ? ` · ${checksText(item.checks)}` : ''}
				</div>
			</Link>
			{open ? <CheckPips checks={item.checks} /> : null}
			{open && item.comments ? (
				<span className="in-num flex shrink-0 items-center gap-1 text-[12px] text-(--text-tertiary)" title="Comments and reviews">
					<Icon icon={MessageSquare} size={12} />
					{item.comments}
				</span>
			) : null}
			<IconBtn icon={ExternalLink} size="sm" label="Open on GitHub" onClick={() => window.open(item.url, '_blank', 'noopener')} />
		</div>
	);
}

/** How many pull requests wait on what, and the checks behind the open ones. */
function Summary({ items }: { items: ReviewItem[] }) {
	const openItems = items.filter((item) => item.group !== 'merged' && item.group !== 'closed');
	const total = (key: keyof ReviewItem['checks']) => openItems.reduce((sum, item) => sum + item.checks[key], 0);
	const failing = items.filter((item) => item.group === 'failing').length;
	return (
		<Card
			icon={GitPullRequest}
			title="Pull requests"
			sub="opened by the agent"
			status={failing ? <Status tone="danger">{failing} failing</Status> : <Status tone="success">No failures</Status>}
		>
			<CardSection ruled={false} className="pt-1">
				<Figure value={String(openItems.length)} unit={`open of ${items.length}`} />
				<SplitBar
					label="Pull requests by what each waits on"
					parts={(Object.keys(GROUPS) as ReviewGroup[]).map((group) => ({ key: group, label: SHORT[group], value: items.filter((item) => item.group === group).length, color: GROUP_COLOR[group] }))}
				/>
			</CardSection>
			<StatRow
				stats={[
					{ label: 'checks passed', value: total('passed'), tone: 'success' },
					{ label: 'checks failed', value: total('failed'), tone: total('failed') ? 'danger' : undefined },
					{ label: 'checks running', value: total('pending'), tone: total('pending') ? 'warning' : undefined },
				]}
			/>
		</Card>
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
				<Card as="div">
					<div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
						<Well grid className="flex w-full max-w-[380px] items-center justify-center py-4">
							<BranchArt className="w-[260px]" />
						</Well>
						<div className="flex flex-col gap-1">
							<div className="text-[14px] font-medium">No pull requests yet</div>
							<div className="max-w-[44ch] text-[12px] leading-[18px] text-(--text-tertiary)">Pull requests the agent opens show up here, with their checks and comments.</div>
						</div>
					</div>
				</Card>
			) : (
				<>
					<Summary items={items} />
					{groups.map(({ group, items }) => (
						<Card
							key={group}
							title={GROUPS[group].label}
							sub={GROUPS[group].help || undefined}
							status={
								<Status tone={GROUP_TONE[group]} pulse={group === 'checking'}>
									{items.length}
								</Status>
							}
						>
							<div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
								{items.map((item) => (
									<Row key={item.sessionId} item={item} />
								))}
							</div>
						</Card>
					))}
				</>
			)}
		</PageFrame>
	);
}
