import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { GitPullRequest, List, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { PageFrame } from '@/components/page-frame';
import { Btn, EmptyState, FilterChip, Icon, Spinner } from '@/components/signal';
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

function Row({ session }: { session: Session }) {
	return (
		<Link
			to="/agents/$sessionId"
			params={{ sessionId: session.id }}
			search={{ app: 'code' }}
			className={`${COLUMNS} min-h-12 rounded-lg px-2.5 py-1.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)`}
		>
			<div className="flex min-w-0 items-center gap-2.5">
				<span className="inline-flex shrink-0">
					<TaskStatusIcon session={session} />
				</span>
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="truncate text-[13px] font-medium">{session.title}</div>
					<div className="flex min-w-0 items-center gap-1.5 text-[11px] text-(--text-tertiary)">
						{session.prUrl ? <Icon icon={GitPullRequest} size={11} className="shrink-0 text-(--accent-text)" /> : null}
						<span className="truncate font-mono">{session.workspace ? session.branch : `${session.baseBranch} (read-only)`}</span>
					</div>
				</div>
			</div>
			<span className="text-right text-[12px] text-(--text-secondary) md:text-left">{statusWord(session)}</span>
			<span className="hidden truncate text-[12px] text-(--text-secondary) md:block">{session.repo}</span>
			<span className="hidden text-right text-[12px] text-(--text-secondary) tabular-nums md:block">{dollars(session.usage.cost)}</span>
			<span className="hidden text-right text-[12px] text-(--text-tertiary) md:block">{age(session.createdAt)}</span>
		</Link>
	);
}

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
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-lg bg-(--bg-surface) px-2.5 focus-within:shadow-(--focus-ring)">
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
				<Spinner size={12} />
			) : shown.length === 0 ? (
				<EmptyState
					icon={List}
					title={all.length ? 'No tasks match' : 'No tasks yet'}
					body={all.length ? 'Try another search or filter.' : 'Start one from New task.'}
				/>
			) : (
				<div className="flex flex-col gap-0.5">
					<div className={`${COLUMNS} px-2.5 pb-1 text-[11px] font-medium tracking-[0.04em] text-(--text-disabled) uppercase`}>
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
		</PageFrame>
	);
}
