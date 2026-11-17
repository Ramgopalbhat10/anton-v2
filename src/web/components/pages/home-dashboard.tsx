import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from '@/lib/icons';
import { type ReactNode, useMemo } from 'react';
import { PrStatus } from '@/components/marks/pr-status';
import { Badge, Icon } from '@/components/kit/signal';
import { StatusDot } from '@/components/kit/instrument';
import { TaskStatusIcon } from '@/components/marks/task-status';
import { api, SAFETY_NET_MS } from '@/lib/api';
import type { Session } from '@/lib/api/sessions';
import { age, dollars } from '@/lib/format';
import { activeAt, repoName } from '@/lib/task-view';
import { stateOf, useSpaceName } from '@/lib/spaces';
import { cn } from '@/lib/utils';

const DAY = 86_400_000;
/** Days the strip's bars cover; the newest seven are this week. */
const DAYS = 14;
const SHOWN = 5;

function localDay(at: Date): number {
	return Math.floor((at.getTime() - at.getTimezoneOffset() * 60_000) / DAY);
}

/** Whether a task waits on you: it asks something, has a plan to approve, or failed; the same state its mark shows, so a done thread never lands here. */
export const needsYou = (session: Session) => stateOf(session) === 'waiting';
export const isRunning = (session: Session) => session.working || session.status === 'starting';

function nextStep(session: Session): string {
	if (session.status === 'error') return 'Open';
	if (session.plan) return 'Review plan';
	if (session.asking) return 'Answer';
	if (session.pullRequest?.conflicts) return 'Resolve conflicts';
	if (session.pullRequest?.checks === 'failed') return 'See checks';
	return 'Open';
}

function TaskLink({ session, children, className }: { session: Session; children: ReactNode; className?: string }) {
	return session.spaceId ? (
		<Link to="/projects/$spaceId/threads/$threadId" params={{ spaceId: session.spaceId, threadId: session.id }} className={className}>
			{children}
		</Link>
	) : (
		<Link to="/agents/$sessionId" params={{ sessionId: session.id }} search={{ app: 'code' }} className={className}>
			{children}
		</Link>
	);
}

function Heading({ title, aside, children }: { title: string; aside?: ReactNode; children?: ReactNode }) {
	return (
		<div className="mb-2 flex h-5 items-center gap-2">
			<h2 className="m-0 text-body-lg leading-5 font-semibold text-(--text)">{title}</h2>
			{aside}
			<span className="flex-1" />
			{children}
		</div>
	);
}

const MORE = 'inline-flex items-center gap-1 rounded-inner text-small text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)';

function Where({ session }: { session: Session }) {
	const spaceName = useSpaceName(session.spaceId);
	return (
		<>
			<span className="shrink-0">{spaceName ?? (session.repo ? repoName(session.repo) : 'Chat')}</span>
			{session.repo && session.workspace && session.branch ? (
				<>
					<span className="text-(--text-4)">·</span>
					<span className="min-w-0 truncate font-mono text-micro">{session.branch}</span>
				</>
			) : null}
		</>
	);
}

function CardRow({ session, note, children }: { session: Session; note?: string | null; children?: ReactNode }) {
	return (
		<TaskLink
			session={session}
			className="group/row flex h-11 min-w-0 items-center gap-2.5 px-3 outline-none not-first:border-t not-first:border-(--line) hover:bg-(--bg-hover) focus-visible:shadow-(--focus-inset)"
		>
			<TaskStatusIcon session={session} size={14} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-body leading-[18px] font-medium text-(--text)">{session.title}</span>
				<span className="flex min-w-0 items-center gap-1.5 text-small leading-4 text-(--text-3)">{note ? <span className="truncate">{note}</span> : <Where session={session} />}</span>
			</span>
			<PrStatus thread={session} />
			{children}
		</TaskLink>
	);
}

const AGE = 'in-num w-7 shrink-0 text-right text-small text-(--text-3)';

function NeedsYou({ sessions }: { sessions: Session[] }) {
	const shown = sessions.slice(0, SHOWN);
	return (
		<section aria-label="Needs you">
			<Heading title="Needs you" aside={<Badge tone="warning">{sessions.length}</Badge>}>
				<Link to="/inbox" className={MORE}>
					Open inbox <Icon icon={ArrowRight} size={12} />
				</Link>
				</Heading>
				<div className="in-card flex flex-col overflow-hidden">
				{shown.map((session) => (
					<CardRow key={session.id} session={session} note={session.asking ?? session.errorMessage}>
						{/* The row is the link; this only says where it leads. */}
						<span aria-hidden className="sg-btn sg-btn--secondary sg-btn--sm pointer-events-none hidden shrink-0 sm:inline-flex">
							{nextStep(session)}
						</span>
						<span className={AGE}>{age(activeAt(session))}</span>
						</CardRow>
					))}
					{sessions.length > shown.length ? (
						<Link to="/tasks" className="flex h-8 items-center gap-1 border-t border-(--line) px-3 text-small text-(--text-3) outline-none hover:bg-(--bg-hover) hover:text-(--text) focus-visible:shadow-(--focus-inset)">
						{sessions.length - shown.length} more in Tasks <Icon icon={ArrowRight} size={12} />
						</Link>
					) : null}
				</div>
			</section>
		);
	}

function Running({ sessions }: { sessions: Session[] }) {
	const shown = sessions.slice(0, SHOWN);
	return (
		<section aria-label="Running">
			<Heading title="Running" aside={<StatusDot tone="accent" pulse />}>
				{sessions.length > shown.length ? (
					<Link to="/tasks" className={MORE}>
						{sessions.length - shown.length} more <Icon icon={ArrowRight} size={12} />
					</Link>
				) : null}
			</Heading>
			<div className="in-card flex flex-col overflow-hidden">
				{shown.map((session) => (
					<CardRow key={session.id} session={session}>
						<span className="in-num shrink-0 text-small text-(--text-3)">
							{session.usage.cost > 0 ? `${dollars(session.usage.cost)} · ` : ''}
							{age(session.lastInputAt ?? session.createdAt)}
						</span>
					</CardRow>
				))}
			</div>
		</section>
	);
}

function Recent({ sessions }: { sessions: Session[] }) {
	return (
		<section aria-label="Recent">
			<Heading title="Recent">
				<Link to="/tasks" className={MORE}>
					All tasks <Icon icon={ArrowRight} size={12} />
				</Link>
			</Heading>
			<div className="-mx-2 flex flex-col">
				{sessions.map((session) => (
					<TaskLink
						key={session.id}
						session={session}
						className="group/row flex h-9 min-w-0 items-center gap-2.5 rounded-control px-2 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
					>
						<TaskStatusIcon session={session} size={14} />
						<span className="min-w-0 flex-1 truncate text-body text-(--text)">{session.title}</span>
						<span className="hidden max-w-[40%] min-w-0 items-center gap-1.5 text-small text-(--text-3) sm:flex">
							<Where session={session} />
						</span>
						<span className={AGE}>{age(activeAt(session))}</span>
					</TaskLink>
				))}
			</div>
		</section>
	);
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col">
			<span className="text-micro leading-4 text-(--text-3)">{label}</span>
			<span className="in-num text-h3 leading-6 font-semibold text-(--text)">{children}</span>
		</div>
	);
}

function Strip({ sessions }: { sessions: Session[] }) {
	const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage, staleTime: 60_000 });
	const { perDay, week, merged } = useMemo(() => {
		const today = localDay(new Date());
		const perDay = Array.from({ length: DAYS }, () => 0);
		let week = 0;
		let merged = 0;
		for (const session of sessions) {
			const back = today - localDay(new Date(session.createdAt));
			if (back < 0 || back >= DAYS) continue;
			perDay[DAYS - 1 - back] += 1;
			if (back < 7) {
				week += 1;
				if (session.pullRequest?.state === 'merged') merged += 1;
			}
		}
		return { perDay, week, merged };
	}, [sessions]);
	const most = Math.max(1, ...perDay);
	return (
		<section aria-label="This week" className="flex items-center gap-5 rounded-card px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
			<Stat label="This week">
				{week} {week === 1 ? 'task' : 'tasks'}
			</Stat>
			<Stat label="Merged">{merged}</Stat>
			<Stat label="Spent this month">{usage.data ? dollars(usage.data.month) : '—'}</Stat>
			<span className="flex-1" />
			<div role="img" aria-label={`Tasks started on each of the last ${DAYS} days`} className="hidden h-7 items-end gap-[3px] sm:flex">
				{perDay.map((count, index) => {
					const back = DAYS - 1 - index;
					return (
						<span
							key={index}
							title={`${count} ${count === 1 ? 'task' : 'tasks'} ${back === 0 ? 'today' : back === 1 ? 'yesterday' : `${back} days ago`}`}
							className={cn('w-1.5 rounded-mark', back < 7 && count > 0 ? 'bg-(--accent)' : 'bg-(--bg-active)')}
							style={{ height: 4 + Math.round((count / most) * 24) }}
						/>
					);
				})}
			</div>
		</section>
	);
}

export function homeSummary(sessions: Session[]): string {
	const waiting = sessions.filter(needsYou).length;
	const running = sessions.filter(isRunning).length;
	const count = (n: number, verb: string) => `${n} ${n === 1 ? 'task is' : 'tasks are'} ${verb}`;
	if (waiting && running) return `${count(waiting, 'waiting on you')} and ${running} ${running === 1 ? 'is' : 'are'} running.`;
	if (waiting) return `${count(waiting, 'waiting on you')}.`;
	if (running) return `${count(running, 'running')}. Nothing is waiting on you.`;
	return 'Nothing is waiting on you.';
}

export function HomeDashboard() {
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: SAFETY_NET_MS });
	const { needs, running, recent, all } = useMemo(() => {
		const all = sessions.data?.sessions ?? [];
		const byActive = [...all].sort((a, b) => activeAt(b).localeCompare(activeAt(a)));
		const needs = byActive.filter(needsYou);
		const running = byActive.filter((session) => isRunning(session) && !needsYou(session));
		const listed = new Set([...needs, ...running].map((session) => session.id));
		return { needs, running, recent: byActive.filter((session) => !listed.has(session.id)).slice(0, SHOWN), all };
	}, [sessions.data]);
	if (!sessions.data || all.length === 0) return null;
	return (
		<div className="flex flex-col gap-7">
			{needs.length ? <NeedsYou sessions={needs} /> : null}
			{running.length ? <Running sessions={running} /> : null}
			{recent.length ? <Recent sessions={recent} /> : null}
			<Strip sessions={all} />
		</div>
	);
}
