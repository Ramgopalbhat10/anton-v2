import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, GitPullRequest, MessageSquare, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { BranchArt } from '@/components/illustrations';
import { Count, Segmented, SegmentedItem } from '@/components/instrument';
import { MenuButton } from '@/components/nav';
import { PullView } from '@/components/pr-tab';
import { PR_ICON, PrFlag, prColor, prNumber } from '@/components/pr-status';
import { FIELD } from '@/components/settings/parts';
import { Badge, Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, type PullRequestItem, type PullRequestState, type ReviewGroup, type ReviewItem } from '@/lib/api';
import { age } from '@/lib/format';
import { taskQueries } from '@/lib/task-queries';
import { cn } from '@/lib/utils';

const GROUPS: Record<ReviewGroup, { label: string; help: string }> = {
	ready: { label: 'Waiting on you', help: 'Checks passed or there are none. Review and merge on GitHub.' },
	failing: { label: 'Failing or conflicting', help: "Anton sends failed checks and merge conflicts on its own pull requests to the agent, unless follow-ups are off for the repository." },
	checking: { label: 'Checks running', help: 'Waiting on CI.' },
	unknown: { label: 'Could not check', help: 'GitHub did not answer for these.' },
	merged: { label: 'Merged', help: '' },
	closed: { label: 'Closed', help: '' },
};

/** The order the queue lists its groups in: what waits on you first, what is done last. */
const OPEN_GROUPS: ReviewGroup[] = ['ready', 'failing', 'checking', 'unknown'];

/** The tabs across the queue: open work, then what already landed or died. */
const TABS = [
	{ id: 'open', label: 'Open', test: (group: ReviewGroup) => group !== 'merged' && group !== 'closed' },
	{ id: 'merged', label: 'Merged', test: (group: ReviewGroup) => group === 'merged' },
	{ id: 'closed', label: 'Closed', test: (group: ReviewGroup) => group === 'closed' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function checksText({ passed, failed, pending }: ReviewItem['checks']): string {
	const parts = [failed && `${failed} failed`, pending && `${pending} running`, passed && `${passed} passed`].filter(Boolean);
	return parts.length ? parts.join(', ') : 'no checks';
}

/** The icon's colour is the pull request's own state; conflicts and failing checks read in the meta line. */
function rowState(item: ReviewItem): PullRequestState | null {
	if (item.group === 'merged' || item.group === 'closed') return item.group;
	if (item.group === 'unknown') return null;
	return item.draft ? 'draft' : 'open';
}

/** One pull request as a dense two-line row: its state glyph, title and flags, then number, repo, checks and age. */
function ReviewRow({ item, selected, onSelect }: { item: ReviewItem; selected: boolean; onSelect: () => void }) {
	const state = rowState(item);
	const number = prNumber(item.url);
	const open = item.group !== 'merged' && item.group !== 'closed';
	return (
		<button
			type="button"
			aria-current={selected || undefined}
			onClick={onSelect}
			className={cn(
				'flex min-h-[56px] w-full items-start gap-2.5 px-3.5 py-2.5 text-left outline-none transition-colors duration-(--t-fast) hover:bg-(--bg-hover) focus-visible:shadow-(--focus-inset)',
				selected && 'bg-(--bg-active)',
			)}
		>
			<span className="mt-0.5 inline-flex shrink-0" style={{ color: prColor(state) }}>
				<Icon icon={PR_ICON[state ?? 'open']} size={15} />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="truncate text-body font-medium text-(--text)">{item.title}</span>
					{item.reviewing ? <Badge tone="accent">Reviewing @{item.reviewing}</Badge> : null}
					{item.draft ? <PrFlag tone="draft">Draft</PrFlag> : null}
					{open && item.conflicts ? <PrFlag tone="conflicts">Conflicts</PrFlag> : null}
				</span>
				<span className="truncate text-small text-(--text-3)">
					{number ? <span className="in-num">#{number}</span> : null} {item.repo}
					<span className="text-(--text-4)"> · </span>
					{open ? checksText(item.checks) : item.group}
					{item.comments ? (
						<>
							<span className="text-(--text-4)"> · </span>
							<span className="inline-flex items-center gap-1">
								<Icon icon={MessageSquare} size={11} className="text-(--text-4)" />
								{item.comments}
							</span>
						</>
					) : null}
				</span>
			</span>
			<span className="in-num shrink-0 pt-0.5 text-micro text-(--text-4)">{age(item.createdAt)}</span>
		</button>
	);
}

/**
 * Any pull request, by its link: Anton reviews it in a task of its own (its
 * own pull requests in the task that opened them), with a security pass,
 * posts the review on GitHub and opens the task.
 */
function ReviewAny({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	const [url, setUrl] = useState('');
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const review = useMutation({
		mutationFn: () => api.reviewAnyPullRequest(url),
		onSuccess: (session) => {
			setUrl('');
			onToggle();
			void queryClient.invalidateQueries({ queryKey: ['reviews'] });
			void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code' } });
		},
	});
	if (!open) return null;
	return (
		<div className="flex shrink-0 flex-col border-b border-(--line)">
			<form
				className="flex h-11 items-center gap-2 px-3"
				onSubmit={(event) => {
					event.preventDefault();
					if (url.trim()) review.mutate();
				}}
			>
				<Icon icon={ShieldCheck} size={13} className="shrink-0 text-(--text-3)" />
				<input
					value={url}
					onChange={(event) => {
						setUrl(event.target.value);
						review.reset();
					}}
					placeholder="https://github.com/owner/repo/pull/12"
					aria-label="Pull request link"
					className={`${FIELD} min-w-0 flex-1 font-mono text-small`}
				/>
				<Btn type="submit" variant="primary" size="sm" disabled={!url.trim() || review.isPending}>
					{review.isPending ? 'Starting…' : 'Review'}
				</Btn>
			</form>
			{review.isError ? <p className="m-0 px-3 pb-2 text-small text-(--bad)">{review.error.message}</p> : null}
		</div>
	);
}

/** The pull request a queue row stands for, as the PR panel takes it; synthesised until the task's own list answers. */
function queueItem(item: ReviewItem): PullRequestItem {
	const number = Number(prNumber(item.url));
	return {
		url: item.url,
		repo: item.repo,
		number,
		title: item.title,
		head: '',
		base: '',
		state: item.group === 'merged' || item.group === 'closed' ? item.group : item.group === 'unknown' ? null : item.draft ? 'draft' : 'open',
		openedAt: item.createdAt,
		mergedAt: null,
		current: true,
	};
}

/** The selected pull request as the task's PR panel shows it: state, branches, checks, discussion and the merge box. */
function ReviewDetail({ item, onBack }: { item: ReviewItem; onBack: () => void }) {
	const pulls = useQuery(taskQueries.pulls(item.sessionId));
	const list = useMemo(() => pulls.data?.pulls ?? [], [pulls.data]);
	const [chosen, setChosen] = useState<number | null>(null);
	useEffect(() => {
		if (chosen !== null && !list.some((pull) => pull.number === chosen)) setChosen(null);
	}, [list, chosen]);
	const matched = list.find((pull) => pull.url === item.url) ?? queueItem(item);
	const shown = list.find((pull) => pull.number === chosen) ?? matched;
	const number = prNumber(item.url);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-3 pl-2 md:pl-4">
				<IconBtn icon={ChevronLeft} size="sm" label="Back to the list" className="md:hidden" onClick={onBack} />
				<nav aria-label="Where you are" className="flex min-w-0 items-center gap-1.5 text-body">
					<span className="truncate text-(--text-2)">{item.repo}</span>
					{number ? <span className="in-num shrink-0 text-(--text-3)">#{number}</span> : null}
				</nav>
				<span className="min-w-2 flex-1" />
				<Link to="/agents/$sessionId" params={{ sessionId: item.sessionId }} search={{ app: 'code' }} className="sg-btn sg-btn--ghost sg-btn--sm shrink-0">
					Open task
				</Link>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-6">
					<PullView
						key={shown.url}
						sessionId={item.sessionId}
						item={shown}
						pulls={list.length ? list : [shown]}
						onSelect={setChosen}
						ownWork={!item.reviewing}
					/>
				</div>
			</div>
		</div>
	);
}

/**
 * Reviews is a pull-request queue beside the pull request itself: the list
 * on the left keeps what each waits on, the panel on the right is the task's
 * own PR view — branches, checks, discussion and the merge box.
 */
export function ReviewsPage() {
	// Pull request state lives on GitHub, which tells Anton nothing, so this asks again every few minutes.
	const reviews = useQuery({ queryKey: ['reviews'], queryFn: api.reviews, refetchInterval: 5 * 60_000 });
	const [tab, setTab] = useState<TabId>('open');
	const [selected, setSelected] = useState<string | null>(null);
	const [reviewAny, setReviewAny] = useState(false);
	const items = useMemo(() => reviews.data?.reviews ?? [], [reviews.data]);

	const sections = useMemo(() => {
		const active = TABS.find((entry) => entry.id === tab)!;
		const visible = items.filter((item) => active.test(item.group));
		if (tab !== 'open') return visible.length ? [{ group: null as ReviewGroup | null, rows: visible }] : [];
		return OPEN_GROUPS.map((group) => ({ group, rows: visible.filter((item) => item.group === group) })).filter((section) => section.rows.length > 0);
	}, [items, tab]);
	const flat = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

	// The panel always shows a pull request: the chosen one, or the first the tab has.
	useEffect(() => {
		setSelected((current) => (current !== null && flat.some((item) => item.url === current) ? current : (flat[0]?.url ?? null)));
	}, [flat]);

	const counts = useMemo(() => Object.fromEntries(TABS.map((entry) => [entry.id, items.filter((item) => entry.test(item.group)).length])) as Record<TabId, number>, [items]);
	const current = flat.find((item) => item.url === selected) ?? null;

	return (
		<div className="flex min-h-0 flex-1">
			<div className={cn('flex min-h-0 min-w-0 flex-col bg-(--bg-panel) md:w-[400px] md:shrink-0 md:shadow-[-1px_0_0_var(--line)_inset]', current ? 'max-md:hidden' : 'max-md:flex-1')}>
				<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-2 pl-2">
					<MenuButton />
					<nav aria-label="Where you are" className="flex min-w-0 shrink-0 items-center text-body">
						<span className="font-medium text-(--text)">Reviews</span>
					</nav>
					<div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
						<Segmented label="Pull requests by state" className="ml-1">
							{TABS.map((entry) => (
								<SegmentedItem key={entry.id} size="sm" on={tab === entry.id} onClick={() => setTab(entry.id)}>
									{entry.label}
									<Count>{counts[entry.id]}</Count>
								</SegmentedItem>
							))}
						</Segmented>
					</div>
					<IconBtn icon={ShieldCheck} size="sm" label="Review a pull request" onClick={() => setReviewAny((open) => !open)} className={cn(reviewAny && 'bg-(--bg-active) text-(--text)')} />
				</header>
				<ReviewAny open={reviewAny} onToggle={() => setReviewAny(false)} />
				<div className="min-h-0 flex-1 overflow-y-auto">
					{reviews.isPending ? (
						<div className="p-4">
							<Spinner size={13} />
						</div>
					) : reviews.isError ? (
						<p className="m-0 p-4 text-small text-(--bad)">Could not load pull requests: {reviews.error.message}</p>
					) : items.length === 0 ? (
						<div className="p-4">
							<EmptyState art={<BranchArt className="w-full max-w-[320px]" />} title="No pull requests yet" body="Pull requests the agent opens or reviews show up here, with their checks and comments." />
						</div>
					) : flat.length === 0 ? (
						<div className="p-4">
							<EmptyState icon={GitPullRequest} title={`No ${TABS.find((entry) => entry.id === tab)!.label.toLowerCase()} pull requests`} />
						</div>
					) : (
						sections.map((section) => (
							<section key={section.group ?? 'all'} aria-label={section.group ? GROUPS[section.group].label : undefined}>
								{section.group ? (
									<div className="flex items-center gap-1.5 px-3.5 pt-3 pb-1 text-micro font-medium text-(--text-3)" title={GROUPS[section.group].help || undefined}>
										{GROUPS[section.group].label}
										<span className="in-num">{section.rows.length}</span>
									</div>
								) : null}
								<div className="flex flex-col">
									{section.rows.map((item, index) => (
										<div key={item.url} className={cn(index > 0 && 'border-t border-(--line)')}>
											<ReviewRow item={item} selected={item.url === selected} onSelect={() => setSelected(item.url)} />
										</div>
									))}
								</div>
							</section>
						))
					)}
				</div>
			</div>
			{current ? (
				<ReviewDetail key={current.url} item={current} onBack={() => setSelected(null)} />
			) : flat.length ? (
				<div className="hidden min-h-0 min-w-0 flex-1 items-center justify-center md:flex">
					<EmptyState icon={GitPullRequest} title="Nothing selected" body="Pick a pull request on the left to read its checks, discussion and merge box." />
				</div>
			) : (
				<div className="hidden min-h-0 min-w-0 flex-1 md:block" />
			)}
		</div>
	);
}
