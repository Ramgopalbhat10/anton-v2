import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CalendarDays, ChevronLeft, ChevronRight, List as ListIcon, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { dayKey, lastDays, StackedDaysChart, type StackRow } from '@/components/charts';
import { TasksArt } from '@/components/illustrations';
import { Caption, Card, CardSection, Figure, type Part, Segmented, SegmentedItem, SplitBar, StatRow, Status } from '@/components/instrument';
import { useModelName } from '@/components/model-picker';
import { PageFrame } from '@/components/page-frame';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { RackCard } from '@/components/task-rack';
import { TaskRow, used } from '@/components/task-row';
import { isLive } from '@/components/task-status';
import { glyphKind } from '@/components/thread-glyph';
import { api, isChat, SAFETY_NET_MS, type Session } from '@/lib/api';
import { dollars, tokens } from '@/lib/format';
import { cn } from '@/lib/utils';

const TABS = {
	all: { label: 'All', test: () => true },
	live: { label: 'Running', test: isLive },
	attention: { label: 'Needs you', test: (session: Session) => ['waiting', 'failed'].includes(glyphKind(session)) },
	pr: { label: 'Pull requests', test: (session: Session) => Boolean(session.prUrl) },
	done: { label: 'Done', test: (session: Session) => glyphKind(session) === 'resolved' },
} satisfies Record<string, { label: string; test: (session: Session) => boolean }>;
type TabKey = keyof typeof TABS;

/** Tasks a page of the list shows. */
export const PAGE_SIZE = 20;

function matches(session: Session, query: string): boolean {
	const text = `${session.title} ${isChat(session) ? 'chat' : `${session.repo} ${session.branch}`} ${session.model}`.toLowerCase();
	return text.includes(query.trim().toLowerCase());
}

/** The pages to offer by number: the first, the last and those around the one shown, gaps as ellipses. */
export function pageNumbers(page: number, pages: number): Array<number | null> {
	const wanted = new Set([0, pages - 1, page - 1, page, page + 1].filter((index) => index >= 0 && index < pages));
	const sorted = [...wanted].sort((a, b) => a - b);
	return sorted.flatMap((index, at) => (at > 0 && index - sorted[at - 1] > 1 ? [null, index] : [index]));
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (page: number) => void }) {
	const first = page * PAGE_SIZE + 1;
	const last = Math.min(total, (page + 1) * PAGE_SIZE);
	return (
		<nav aria-label="Pages" className="flex flex-wrap items-center gap-2 border-t border-(--border-subtle) px-3 py-2">
			<Caption className="flex-1">
				{first}–{last} of {total}
			</Caption>
			{pages > 1 ? (
				<div className="flex items-center gap-0.5">
					<IconBtn icon={ChevronLeft} size="xs" label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)} />
					{pageNumbers(page, pages).map((index, at) =>
						index === null ? (
							<span key={`gap-${at}`} className="w-5 text-center text-[11px] text-(--text-disabled)">
								…
							</span>
						) : (
							<button
								key={index}
								type="button"
								aria-current={index === page ? 'page' : undefined}
								aria-label={`Page ${index + 1}`}
								onClick={() => onPage(index)}
								className={cn(
									'in-num inline-flex h-6 min-w-6 items-center justify-center rounded-[6px] px-1.5 text-[11px] outline-none focus-visible:shadow-(--focus-ring)',
									index === page ? 'bg-(--accent-bg-subtle) text-(--accent-text) shadow-[inset_0_0_0_1px_var(--accent-border)]' : 'text-(--text-tertiary) hover:bg-(--bg-hover) hover:text-(--text-primary)',
								)}
							>
								{index + 1}
							</button>
						),
					)}
					<IconBtn icon={ChevronRight} size="xs" label="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} />
				</div>
			) : null}
		</nav>
	);
}

const DAYS = 14;

/** Every task at a glance: how many in each state, how much they cost, and how many started each day. */
function Summary({ sessions }: { sessions: Session[] }) {
	const days = useMemo(() => lastDays(DAYS), []);
	const rows = useMemo(() => {
		const counts = new Map<string, StackRow>();
		for (const session of sessions) {
			const day = dayKey(new Date(session.createdAt));
			const series = isLive(session) ? 'Running' : session.status === 'error' ? 'Failed' : session.prUrl ? 'Pull request' : 'Stopped';
			const key = `${day} ${series}`;
			const entry = counts.get(key) ?? { day, series, value: 0 };
			entry.value += 1;
			counts.set(key, entry);
		}
		return [...counts.values()];
	}, [sessions]);
	const cost = sessions.reduce((sum, session) => sum + session.usage.cost, 0);
	const tokensUsed = sessions.reduce((sum, session) => sum + used(session), 0);
	const parts: Part[] = [
		{ key: 'live', label: 'Running', value: sessions.filter(isLive).length, color: 'var(--accent-base)' },
		{ key: 'pr', label: 'With a pull request', value: sessions.filter((session) => !isLive(session) && session.status !== 'error' && session.prUrl).length, color: 'var(--data-2)' },
		{ key: 'stopped', label: 'Stopped', value: sessions.filter((session) => !isLive(session) && session.status !== 'error' && !session.prUrl).length, color: 'var(--neutral-500)' },
		{ key: 'error', label: 'Failed', value: sessions.filter((session) => session.status === 'error').length, color: 'var(--danger-base)' },
	];
	return (
		<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
			<Card icon={ListIcon} title="All tasks" sub="by state" status={parts[0].value ? <Status tone="accent" pulse>{parts[0].value} live</Status> : <Status>None running</Status>}>
				<CardSection ruled={false} className="pt-1">
					<Figure value={String(sessions.length)} unit={sessions.length === 1 ? 'task' : 'tasks'} />
					<SplitBar label="Tasks by state" parts={parts} />
				</CardSection>
				<StatRow
					className="mt-auto"
					stats={[
						{ label: 'spent on models', value: dollars(cost) },
						{ label: 'per task', value: sessions.length ? dollars(cost / sessions.length) : '$0' },
						{ label: 'tokens', value: tokens(tokensUsed) },
					]}
				/>
			</Card>
			<Card icon={CalendarDays} title="Started" sub={`last ${DAYS} days`}>
				<CardSection ruled={false} className="pt-1">
					<StackedDaysChart
						rows={rows}
						days={days}
						series={SERIES}
						colors={SERIES_COLORS}
						whole
						format={(value) => `${Math.round(value)}`}
						label={`Tasks started each day over the last ${DAYS} days, by state`}
						height={150}
					/>
				</CardSection>
			</Card>
		</div>
	);
}

/** The chart's series, bottom first, in the same colours as the split bar beside it. */
const SERIES = ['Running', 'Pull request', 'Stopped', 'Failed'];
const SERIES_COLORS = ['var(--accent-base)', 'var(--data-2)', 'var(--neutral-500)', 'var(--danger-base)'];

/** Every task, searchable and filtered by state, newest first, a page at a time. */
export function TasksPage() {
	const navigate = useNavigate();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: SAFETY_NET_MS });
	const modelName = useModelName();
	const [query, setQuery] = useState('');
	const [tab, setTab] = useState<TabKey>('all');
	const [wantedPage, setPage] = useState(0);
	const all = sessions.data?.sessions ?? [];
	const searched = all.filter((session) => matches(session, query));
	const shown = searched.filter(TABS[tab].test);
	const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
	const page = Math.min(wantedPage, pages - 1);
	return (
		<PageFrame
			title="Tasks"
			actions={
				<Btn size="sm" icon={Plus} onClick={() => void navigate({ to: '/' })}>
					New task
				</Btn>
			}
		>
			{all.length ? <RackCard sessions={all} /> : null}
			{all.length ? <Summary sessions={all} /> : null}
			<Card as="div">
				<div className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) p-2.5">
					<Segmented label="Tasks by state" className="max-w-full overflow-x-auto">
						{(Object.keys(TABS) as TabKey[]).map((key) => (
							<SegmentedItem
								key={key}
								on={tab === key}
								size="sm"
								onClick={() => {
									setTab(key);
									setPage(0);
								}}
							>
								{TABS[key].label}
								<span className="in-num text-[10.5px] text-(--text-disabled)">{searched.filter(TABS[key].test).length}</span>
							</SegmentedItem>
						))}
					</Segmented>
					<div className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-full border border-(--border-subtle) bg-(--well-bg) px-3 focus-within:shadow-(--focus-ring)">
						<Icon icon={Search} size={12} className="text-(--icon-tertiary)" />
						<input
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setPage(0);
							}}
							placeholder="Search tasks"
							aria-label="Search tasks"
							className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled)"
						/>
					</div>
				</div>
				{sessions.isPending ? (
					<div className="p-4">
						<Spinner size={12} />
					</div>
				) : shown.length === 0 ? (
					all.length ? (
						<EmptyState title="No tasks match" />
					) : (
						<div className="p-1.5">
							<EmptyState art={<TasksArt className="w-full max-w-[320px]" />} title="No tasks yet" />
						</div>
					)
				) : (
					<>
						<div className="flex flex-col gap-0.5 p-1.5">
							{shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((session) => (
								<TaskRow key={session.id} session={session} modelName={modelName} />
							))}
						</div>
						<Pager page={page} pages={pages} total={shown.length} onPage={setPage} />
					</>
				)}
			</Card>
		</PageFrame>
	);
}
