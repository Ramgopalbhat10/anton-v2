import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { CalendarDays, GitPullRequest, List as ListIcon, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { dayKey, lastDays, StackedDaysChart, type StackRow } from '@/components/charts';
import { TasksArt } from '@/components/illustrations';
import { Card, CardSection, Figure, type Part, SplitBar, StatRow, Status, type Tone, toneFill, Well } from '@/components/instrument';
import { PageFrame } from '@/components/page-frame';
import { Btn, FilterChip, Icon, Spinner } from '@/components/signal';
import { isLive, liveLabel, TaskStatusIcon } from '@/components/task-status';
import { api, SAFETY_NET_MS, type Session } from '@/lib/api';
import { age, dollars } from '@/lib/format';

const FILTERS = {
	live: { label: 'Running', test: isLive },
	stopped: { label: 'Stopped', test: (session: Session) => !isLive(session) && session.status !== 'error' },
	failed: { label: 'Failed', test: (session: Session) => session.status === 'error' },
	pr: { label: 'Pull request', test: (session: Session) => Boolean(session.prUrl) },
} satisfies Record<string, { label: string; test: (session: Session) => boolean }>;
type Filter = keyof typeof FILTERS;

const statusWord = (session: Session) => (isLive(session) ? liveLabel(session) : session.status === 'error' ? 'Failed' : 'Stopped');

function matches(session: Session, query: string, filter: Filter | null): boolean {
	const text = `${session.title} ${session.repo} ${session.branch}`.toLowerCase();
	return text.includes(query.trim().toLowerCase()) && (!filter || FILTERS[filter].test(session));
}

const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_88px] items-center gap-3 md:grid-cols-[minmax(0,1fr)_96px_minmax(0,180px)_64px_56px]';

const STATE_TONE = (session: Session): Tone => (isLive(session) ? 'accent' : session.status === 'error' ? 'danger' : 'neutral');

function Row({ session }: { session: Session }) {
	return (
		<Link
			to="/agents/$sessionId"
			params={{ sessionId: session.id }}
			search={{ app: 'code' }}
			className={`${COLUMNS} min-h-[52px] rounded-[10px] px-2.5 py-1.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)`}
		>
			<div className="flex min-w-0 items-center gap-2.5">
				<span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-(--border-subtle) bg-(--well-bg)">
					<TaskStatusIcon session={session} size={13} />
				</span>
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="truncate text-[13px] font-medium">{session.title}</div>
					<div className="flex min-w-0 items-center gap-1.5 text-[11px] text-(--text-tertiary)">
						{session.prUrl ? <Icon icon={GitPullRequest} size={11} className="shrink-0 text-(--accent-text)" /> : null}
						<span className="truncate font-mono">{session.workspace ? session.branch : `${session.baseBranch} (read-only)`}</span>
					</div>
				</div>
			</div>
			<span className={`flex items-center justify-end gap-1.5 text-[12px] md:justify-start ${STATE_TONE(session) === 'danger' ? 'text-(--danger-text)' : STATE_TONE(session) === 'accent' ? 'text-(--accent-text)' : 'text-(--text-secondary)'}`}>
				<span className="size-1.5 shrink-0 rounded-full" style={{ background: toneFill(STATE_TONE(session)) }} />
				{statusWord(session)}
			</span>
			<span className="hidden truncate text-[12px] text-(--text-secondary) md:block">{session.repo}</span>
			<span className="in-num hidden text-right text-[12px] text-(--text-secondary) md:block">{dollars(session.usage.cost)}</span>
			<span className="in-num hidden text-right text-[12px] text-(--text-tertiary) md:block">{age(session.createdAt)}</span>
		</Link>
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
	const recent = rows.filter((row) => days.includes(row.day)).reduce((sum, row) => sum + row.value, 0);
	const parts: Part[] = [
		{ key: 'live', label: 'Running', value: sessions.filter(isLive).length, color: 'var(--accent-base)' },
		{ key: 'pr', label: 'With a pull request', value: sessions.filter((session) => !isLive(session) && session.status !== 'error' && session.prUrl).length, color: 'var(--data-2)' },
		{ key: 'stopped', label: 'Stopped', value: sessions.filter((session) => !isLive(session) && session.status !== 'error' && !session.prUrl).length, color: 'var(--neutral-500)' },
		{ key: 'error', label: 'Failed', value: sessions.filter((session) => session.status === 'error').length, color: 'var(--danger-base)' },
	];
	return (
		<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
			<Card icon={ListIcon} title="All tasks" sub="by state" status={parts[0].value ? <Status tone="accent" pulse>{parts[0].value} live</Status> : <Status>Idle</Status>}>
				<CardSection ruled={false} className="pt-1">
					<Figure value={String(sessions.length)} unit={sessions.length === 1 ? 'task' : 'tasks'} />
					<SplitBar label="Tasks by state" parts={parts} />
				</CardSection>
				<StatRow
					className="mt-auto"
					stats={[
						{ label: 'spent on models', value: dollars(cost) },
						{ label: 'per task', value: sessions.length ? dollars(cost / sessions.length) : '$0' },
					]}
				/>
			</Card>
			<Card icon={CalendarDays} title="Started" sub={`last ${DAYS} days`} status={<Status>{recent} {recent === 1 ? 'task' : 'tasks'}</Status>}>
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

/** Every task, searchable and filtered by state, newest first. */
export function TasksPage() {
	const navigate = useNavigate();
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: SAFETY_NET_MS });
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<Filter | null>(null);
	const all = sessions.data?.sessions ?? [];
	const shown = all.filter((session) => matches(session, query, filter));
	return (
		<PageFrame
			title="Tasks"
			actions={
				<Btn size="sm" icon={Plus} onClick={() => void navigate({ to: '/' })}>
					New task
				</Btn>
			}
		>
			{all.length ? <Summary sessions={all} /> : null}
			<Card as="div">
				<div className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) p-2.5">
					<div className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-full border border-(--border-subtle) bg-(--well-bg) px-3 focus-within:shadow-(--focus-ring)">
						<Icon icon={Search} size={12} className="text-(--icon-tertiary)" />
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search by title, repository or branch"
							aria-label="Search tasks"
							className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled)"
						/>
					</div>
					<div className="flex items-center gap-1">
						{(Object.keys(FILTERS) as Filter[]).map((key) => (
							<FilterChip key={key} label={FILTERS[key].label} on={filter === key} onToggle={() => setFilter(filter === key ? null : key)} />
						))}
					</div>
				</div>
				{sessions.isPending ? (
					<div className="p-4">
						<Spinner size={12} />
					</div>
				) : shown.length === 0 ? (
					<div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
						{all.length ? null : (
							<Well grid className="flex w-full max-w-[360px] items-center justify-center py-4">
								<TasksArt className="w-[190px]" />
							</Well>
						)}
						<div className="flex flex-col gap-1">
							<div className="text-[14px] font-medium">{all.length ? 'No tasks match' : 'No tasks yet'}</div>
							<div className="text-[12px] text-(--text-tertiary)">{all.length ? 'Try another search or filter.' : 'Start one from New task.'}</div>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-0.5 p-1.5">
						<div className={`${COLUMNS} in-caption px-2.5 pt-1 pb-1.5`}>
							<span>Task</span>
							<span className="text-right md:text-left">Status</span>
							<span className="hidden md:block">Repository</span>
							<span className="hidden text-right md:block">Cost</span>
							<span className="hidden text-right md:block">Started</span>
						</div>
						{shown.map((session) => (
							<Row key={session.id} session={session} />
						))}
					</div>
				)}
			</Card>
		</PageFrame>
	);
}
