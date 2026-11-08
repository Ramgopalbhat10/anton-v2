import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, CalendarRange, Clock, EyeOff, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Image as ImageIcon, type LucideIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/signal';
import { TaskStatusIcon } from '@/components/task-status';
import { api, SAFETY_NET_MS, type Session } from '@/lib/api';
import { age, dollars } from '@/lib/format';
import { setSkyOn, type SkyImage, skyLink, untilNextHour, useSky, useSkyOn } from '@/lib/sky';
import { cn } from '@/lib/utils';

/*
 * Home's dashboard, under the composer: what Anton has been doing, in four
 * glass cards over the sky. Activity (a heatmap of tasks per day), the latest
 * tasks, the pull requests they opened, and this month against the last.
 */

const DAY = 86_400_000;
/** Weeks of activity shown, newest on the right. */
const WEEKS = 30;

function localDay(at: Date): number {
	return Math.floor((at.getTime() - at.getTimezoneOffset() * 60_000) / DAY);
}

/** A glass card with a small header: an icon, a title, and something on the right. */
function Panel({ icon, title, aside, children, className, footer }: { icon: LucideIcon; title: string; aside?: ReactNode; children: ReactNode; className?: string; footer?: ReactNode }) {
	return (
		<section aria-label={title} className={cn('home-panel flex min-w-0 flex-col', className)}>
			<header className="flex h-9 shrink-0 items-center gap-2 px-3.5 text-[12px] text-(--text-secondary)">
				<Icon icon={icon} size={13} className="text-(--icon-tertiary)" />
				<h2 className="m-0 min-w-0 flex-1 truncate text-[12px] font-medium">{title}</h2>
				{aside}
			</header>
			<div className="flex min-h-0 flex-1 flex-col px-3.5 pb-3">{children}</div>
			{footer ? <footer className="flex h-8 shrink-0 items-center gap-2 px-3.5 pb-1 text-[11.5px] text-(--text-tertiary)">{footer}</footer> : null}
		</section>
	);
}

function prNumber(session: Session): string | null {
	const match = session.prUrl?.match(/\/pull\/(\d+)/);
	return match ? `#${match[1]}` : null;
}

const LEVEL = ['var(--heat-0)', 'var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)'];

/** Tasks started each day over the last few months, as a heatmap: a column per week, Monday at the top. */
function Activity({ sessions }: { sessions: Session[] }) {
	const { weeks, total, merged, from, to } = useMemo(() => {
		const today = new Date();
		const todayIndex = localDay(today);
		// Monday-first weekday of today, so the last column ends on today's week.
		const weekday = (today.getDay() + 6) % 7;
		const start = todayIndex - weekday - (WEEKS - 1) * 7;
		const counts = new Map<number, number>();
		for (const session of sessions) {
			const day = localDay(new Date(session.createdAt));
			if (day >= start && day <= todayIndex) counts.set(day, (counts.get(day) ?? 0) + 1);
		}
		const most = Math.max(1, ...counts.values());
		const weeks = Array.from({ length: WEEKS }, (_, week) =>
			Array.from({ length: 7 }, (_, row) => {
				const day = start + week * 7 + row;
				const count = counts.get(day) ?? 0;
				const level = day > todayIndex ? -1 : count === 0 ? 0 : Math.min(4, Math.ceil((count / most) * 4));
				return { day, count, level };
			}),
		);
		const inRange = sessions.filter((session) => localDay(new Date(session.createdAt)) >= start);
		const month = (day: number) => new Date(day * DAY).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
		return {
			weeks,
			total: inRange.length,
			merged: inRange.filter((session) => session.pullRequest?.state === 'merged').length,
			from: month(start),
			to: month(todayIndex),
		};
	}, [sessions]);
	return (
		<Panel
			icon={CalendarRange}
			title="Activity"
			className="md:col-span-2"
			footer={
				<>
					<span className="in-num min-w-0 flex-1 truncate">
						{total} {total === 1 ? 'task' : 'tasks'} · {merged} merged
					</span>
					<span>
						{from} – {to}
					</span>
				</>
			}
		>
			<div
				role="img"
				aria-label={`${total} tasks started over the last ${WEEKS} weeks`}
				className="home-heat flex min-h-0 flex-1 items-center pt-1"
			>
				<div className="grid w-full max-w-[560px] grid-flow-col grid-rows-7 gap-[3px]" style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}>
					{weeks.flat().map((cell) => (
						<span
							key={cell.day}
							title={cell.level < 0 ? undefined : `${cell.count} ${cell.count === 1 ? 'task' : 'tasks'} on ${new Date(cell.day * DAY).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}`}
							className="aspect-square rounded-[2px]"
							style={{ background: cell.level < 0 ? 'transparent' : LEVEL[cell.level] }}
						/>
					))}
				</div>
			</div>
		</Panel>
	);
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

const ROW = 'group/row -mx-1.5 flex h-[30px] min-w-0 items-center gap-2.5 rounded-[6px] px-1.5 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)';

/** The latest tasks, each a line: its state, its title and how long ago. */
function Recent({ sessions }: { sessions: Session[] }) {
	const shown = sessions.slice(0, 5);
	const more = sessions.length - shown.length;
	return (
		<Panel
			icon={Clock}
			title="Recent"
			footer={
				more > 0 ? (
					<Link to="/tasks" className="rounded-sm outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)">
						{more} more
					</Link>
				) : null
			}
		>
			{shown.length ? (
				<div className="flex flex-col">
					{shown.map((session) => (
						<TaskLink key={session.id} session={session} className={ROW}>
							<TaskStatusIcon session={session} size={12} />
							<span className="min-w-0 flex-1 truncate text-[12.5px] text-(--text-secondary) group-hover/row:text-(--text-primary)">{session.title}</span>
							<span className="in-num shrink-0 text-[11px] text-(--text-disabled)">{age(session.lastInputAt ?? session.createdAt)}</span>
						</TaskLink>
					))}
				</div>
			) : (
				<p className="m-0 py-2 text-[12px] text-(--text-tertiary)">Tasks you start show up here.</p>
			)}
		</Panel>
	);
}

const PR_LOOK: Record<NonNullable<Session['pullRequest']>['state'], { icon: LucideIcon; color: string; label: string }> = {
	open: { icon: GitPullRequest, color: 'var(--success-text)', label: 'Open' },
	draft: { icon: GitPullRequestDraft, color: 'var(--text-tertiary)', label: 'Draft' },
	merged: { icon: GitMerge, color: 'var(--data-2)', label: 'Merged' },
	closed: { icon: GitPullRequestClosed, color: 'var(--danger-text)', label: 'Closed' },
};

/** Pull requests the agent opened, newest first, with their state and repository. */
function PullRequests({ sessions }: { sessions: Session[] }) {
	const withPr = sessions.filter((session) => session.prUrl);
	const shown = withPr.slice(0, 4);
	const more = withPr.length - shown.length;
	return (
		<Panel
			icon={GitPullRequest}
			title="Pull requests"
			className="md:col-span-2"
			footer={
				more > 0 ? (
					<Link to="/tasks" className="rounded-sm outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)">
						{more} more
					</Link>
				) : null
			}
		>
			{shown.length ? (
				<div className="flex flex-col">
					{shown.map((session) => {
						const look = PR_LOOK[session.pullRequest?.state ?? 'open'];
						return (
							<TaskLink key={session.id} session={session} className={cn(ROW, 'h-[38px]')}>
								<span role="img" aria-label={look.label} className="inline-flex shrink-0 self-start pt-[5px]" style={{ color: look.color }}>
									<Icon icon={look.icon} size={13} />
								</span>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-[12.5px] leading-4 text-(--text-secondary) group-hover/row:text-(--text-primary)">{session.title}</span>
									<span className="truncate text-[11px] leading-4 text-(--text-disabled)">
										<span className="in-num">{prNumber(session)}</span> · {session.repo.split('/').pop()} · {age(session.createdAt)}
										{session.pullRequest?.checks === 'failed' ? <span className="text-(--danger-text)"> · checks failing</span> : null}
									</span>
								</span>
							</TaskLink>
						);
					})}
				</div>
			) : (
				<p className="m-0 py-2 text-[12px] text-(--text-tertiary)">Pull requests the agent opens show up here, with their checks.</p>
			)}
		</Panel>
	);
}

function Delta({ now, before }: { now: number; before: number }) {
	if (now === before) return null;
	const up = now > before;
	return (
		<span className={cn('in-num text-[11px]', up ? 'text-(--success-text)' : 'text-(--text-tertiary)')}>
			{up ? '+' : '−'}
			{Math.abs(now - before)}
		</span>
	);
}

/** This month against the last: tasks started and pull requests merged, and what it cost. */
function ThisMonth({ sessions }: { sessions: Session[] }) {
	const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage, staleTime: 60_000 });
	const now = new Date();
	const monthOf = (iso: string) => {
		const at = new Date(iso);
		return at.getFullYear() * 12 + at.getMonth();
	};
	const current = now.getFullYear() * 12 + now.getMonth();
	const started = (month: number) => sessions.filter((session) => monthOf(session.createdAt) === month).length;
	const merged = (month: number) => sessions.filter((session) => session.pullRequest?.state === 'merged' && monthOf(session.createdAt) === month).length;
	const stat = (label: string, value: ReactNode, delta?: ReactNode) => (
		<div className="flex flex-col gap-0.5">
			<span className="text-[11.5px] text-(--text-tertiary)">{label}</span>
			<span className="flex items-baseline gap-2">
				<span className="in-figure text-[22px] leading-7">{value}</span>
				{delta}
			</span>
		</div>
	);
	return (
		<Panel icon={CalendarRange} title={now.toLocaleDateString(undefined, { month: 'long' })}>
			<div className="flex flex-col gap-2.5 pt-0.5">
				{stat('Tasks', started(current), <Delta now={started(current)} before={started(current - 1)} />)}
				{stat('Merged', merged(current), <Delta now={merged(current)} before={merged(current - 1)} />)}
				{stat('Spent', usage.data ? dollars(usage.data.month) : '—')}
			</div>
		</Panel>
	);
}

export function HomeDashboard() {
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: SAFETY_NET_MS });
	const list = useMemo(() => [...(sessions.data?.sessions ?? [])].sort((a, b) => Date.parse(b.lastInputAt ?? b.createdAt) - Date.parse(a.lastInputAt ?? a.createdAt)), [sessions.data]);
	const byCreated = useMemo(() => [...(sessions.data?.sessions ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [sessions.data]);
	if (!sessions.data) return null;
	return (
		<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
			<Activity sessions={byCreated} />
			<Recent sessions={list} />
			<PullRequests sessions={byCreated} />
			<ThisMonth sessions={byCreated} />
		</div>
	);
}

/** "in 23 min", until the sky moves on to its next picture. */
function useNextIn(): string {
	const [left, setLeft] = useState(() => untilNextHour(new Date()));
	useEffect(() => {
		const timer = setInterval(() => setLeft(untilNextHour(new Date())), 30_000);
		return () => clearInterval(timer);
	}, []);
	const minutes = Math.max(1, Math.ceil(left / 60_000));
	return `${minutes} min`;
}

/** The hour's picture, credited, in Home's corner: where it comes from, when it changes, and a way to turn the sky off. */
export function SkyCredit() {
	const on = useSkyOn();
	const image: SkyImage = useSky();
	const next = useNextIn();
	if (!on) return null;
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					aria-label={`Sky: ${image.title}, ${image.credit}`}
					className="sky-credit inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] text-(--text-tertiary) outline-none hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring)"
				>
					<Icon icon={ImageIcon} size={11} />
					<span className="truncate">{image.title}</span>
					<span className="hidden shrink-0 text-(--text-disabled) sm:inline">· {image.credit}</span>
				</button>
			</MenuTrigger>
			<MenuContent align="end" side="top" className="w-[260px]">
				<MenuLabel>
					<span className="block text-[12px] text-(--text-primary)">{image.title}</span>
					<span className="block font-normal">
						{image.credit} · next picture in {next}
					</span>
				</MenuLabel>
				<MenuSeparator />
				<MenuItem icon={ArrowUpRight} onSelect={() => window.open(skyLink(image), '_blank', 'noopener')}>
					Open at NASA
				</MenuItem>
				<MenuItem icon={EyeOff} onSelect={() => setSkyOn(false)}>
					Turn the sky off
				</MenuItem>
			</MenuContent>
		</Menu>
	);
}
