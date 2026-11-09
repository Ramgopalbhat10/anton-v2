import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, CalendarRange, Clock, EyeOff, GitPullRequest, Image as ImageIcon, type LucideIcon, Shuffle, Telescope } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { PR_ICON, prColor, prTone } from '@/components/pr-status';
import { Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/signal';
import { TaskStatusIcon } from '@/components/task-status';
import { api, SAFETY_NET_MS, type Session } from '@/lib/api';
import { age, dollars } from '@/lib/format';
import { SkyBrightnessSlider } from '@/components/sky';
import { setSkyMode, setSkyOn, shuffleSky, type SkyImage, skyLink, untilNextHour, useSky, useSkyMode, useSkyOn } from '@/lib/sky';
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

type PrState = NonNullable<Session['pullRequest']>['state'];
const PR_LABEL: Record<PrState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
/** The last pull requests the ribbon draws, a tile each. */
const RIBBON = 24;

/** What a pull request still asks of you, first: open ones before drafts, then the rest by age. */
const waiting = (session: Session) => (session.pullRequest?.state === 'open' ? 0 : session.pullRequest?.state === 'draft' ? 1 : 2);

/** A pull request's state as a small tinted word, in the PR colours. */
function PrPill({ state, conflicts, failing }: { state: PrState; conflicts?: boolean; failing?: boolean }) {
	const active = state === 'open' || state === 'draft';
	const tone = active && conflicts ? 'conflicts' : active && failing ? 'failing' : state;
	const label = active && conflicts ? 'Conflicts' : active && failing ? 'Failing' : PR_LABEL[state];
	return (
		<span className="inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[10.5px] font-medium" style={{ color: prTone(tone), background: `color-mix(in oklab, ${prTone(tone)} 13%, transparent)` }}>
			{label}
		</span>
	);
}

/**
 * Pull requests the agent opened: the ones still open on the left, each with
 * its state as a pill, and on the right a ribbon of the last 24 as tiles in
 * their state's colour, newest last, under how many of them merged.
 */
function PullRequests({ sessions }: { sessions: Session[] }) {
	const withPr = sessions.filter((session) => session.prUrl);
	const shown = [...withPr].sort((a, b) => waiting(a) - waiting(b)).slice(0, 4);
	const recent = withPr.slice(0, RIBBON).reverse();
	const count = (state: PrState) => withPr.filter((session) => (session.pullRequest?.state ?? 'open') === state).length;
	const merged = recent.filter((session) => session.pullRequest?.state === 'merged').length;
	const open = count('open') + count('draft');
	const more = withPr.length - shown.length;
	return (
		<Panel
			icon={GitPullRequest}
			title="Pull requests"
			className="md:col-span-2"
			aside={open ? <span className="in-num text-[11.5px] text-(--text-tertiary)">{open} open</span> : null}
			footer={
				more > 0 ? (
					<Link to="/reviews" className="rounded-sm outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring)">
						{more} more
					</Link>
				) : null
			}
		>
			{shown.length ? (
				<div className="grid min-h-0 flex-1 grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-[minmax(0,1fr)_188px]">
					<div className="flex min-w-0 flex-col">
						{shown.map((session) => {
							const state = session.pullRequest?.state ?? 'open';
							return (
								<TaskLink key={session.id} session={session} className={cn(ROW, 'h-[38px]')}>
									<span role="img" aria-label={PR_LABEL[state]} className="inline-flex shrink-0 self-start pt-[5px]" style={{ color: prColor(session.pullRequest?.state) }}>
										<Icon icon={PR_ICON[state]} size={13} />
									</span>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate text-[12.5px] leading-4 text-(--text-secondary) group-hover/row:text-(--text-primary)">{session.title}</span>
										<span className="truncate text-[11px] leading-4 text-(--text-disabled)">
											<span className="in-num">{prNumber(session)}</span> · {session.repo.split('/').pop()} · {age(session.createdAt)}
										</span>
									</span>
									<PrPill state={state} conflicts={session.pullRequest?.conflicts} failing={session.pullRequest?.checks === 'failed'} />
								</TaskLink>
							);
						})}
					</div>
					<div className="flex min-w-0 flex-col justify-between gap-3 rounded-[10px] bg-(--alpha-white-3) p-3">
						<div className="flex items-baseline gap-1.5">
							<span className="in-figure text-[24px] leading-7">{merged}</span>
							<span className="text-[11.5px] text-(--text-tertiary)">of the last {recent.length} merged</span>
						</div>
						<div role="img" aria-label={`The last ${recent.length} pull requests by state, oldest first`} className="grid grid-cols-12 gap-[3px]">
							{Array.from({ length: RIBBON }, (_, index) => {
								const session = recent[index - (RIBBON - recent.length)];
								const state = session?.pullRequest?.state ?? (session ? 'open' : null);
								return (
									<span
										key={index}
										title={session ? `${prNumber(session)} ${session.title} · ${PR_LABEL[state!].toLowerCase()}` : undefined}
										className="h-[18px] rounded-[2px]"
										style={state ? { background: `color-mix(in oklab, ${prColor(state)} 78%, transparent)` } : { background: 'var(--heat-0)' }}
									/>
								);
							})}
						</div>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-(--text-tertiary)">
							{(['merged', 'open', 'draft', 'closed'] as const).map((state) =>
								count(state) ? (
									<span key={state} className="inline-flex items-center gap-1.5">
										<span className="size-1.5 rounded-full" style={{ background: prColor(state) }} />
										{PR_LABEL[state]}
										<span className="in-num text-(--text-disabled)">{count(state)}</span>
									</span>
								) : null,
							)}
						</div>
					</div>
				</div>
			) : (
				<p className="m-0 py-2 text-[12px] text-(--text-tertiary)">Pull requests the agent opens show up here, with their checks.</p>
			)}
		</Panel>
	);
}

/** How this month compares with the last at the same day of it, in words: a month that has barely begun is not behind a whole one. */
function pace(now: number, before: number, last: string): string {
	if (now === before) return `Level with ${last}`;
	return now > before ? `${now - before} ahead of ${last}` : `${before - now} behind ${last}`;
}

/**
 * This month so far: a bar for each of its days (the days to come drawn
 * hollow, today lit), the tasks started against last month by the same day,
 * and what it merged and cost.
 */
function ThisMonth({ sessions }: { sessions: Session[] }) {
	const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage, staleTime: 60_000 });
	const now = new Date();
	const year = now.getFullYear();
	const month = now.getMonth();
	const today = now.getDate();
	const length = new Date(year, month + 1, 0).getDate();
	const { perDay, started, merged, before } = useMemo(() => {
		const perDay = Array.from({ length }, () => 0);
		let started = 0;
		let merged = 0;
		let before = 0;
		for (const session of sessions) {
			const at = new Date(session.createdAt);
			if (at.getFullYear() === year && at.getMonth() === month) {
				perDay[at.getDate() - 1] += 1;
				started += 1;
				if (session.pullRequest?.state === 'merged') merged += 1;
			} else if (at.getFullYear() * 12 + at.getMonth() === year * 12 + month - 1 && at.getDate() <= today) before += 1;
		}
		return { perDay, started, merged, before };
	}, [sessions, year, month, today, length]);
	const most = Math.max(1, ...perDay);
	const lastName = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long' });
	return (
		<Panel
			icon={CalendarRange}
			title={now.toLocaleDateString(undefined, { month: 'long' })}
			aside={
				<span className="in-num text-[11.5px] text-(--text-tertiary)">
					Day {today} of {length}
				</span>
			}
		>
			<div className="flex min-h-0 flex-1 flex-col justify-between gap-3">
				<div className="flex flex-col gap-0.5">
					<span className="flex items-baseline gap-1.5">
						<span className="in-figure text-[26px] leading-8">{started}</span>
						<span className="text-[12px] text-(--text-tertiary)">{started === 1 ? 'task' : 'tasks'} so far</span>
					</span>
					<span className={cn('text-[11.5px]', started > before ? 'text-(--accent-text)' : 'text-(--text-tertiary)')}>{pace(started, before, lastName)}</span>
				</div>
				<div role="img" aria-label={`Tasks started each day of ${now.toLocaleDateString(undefined, { month: 'long' })}`} className="flex h-12 items-end gap-[2px]">
					{perDay.map((count, index) => {
						const day = index + 1;
						const future = day > today;
						return (
							<span
								key={day}
								title={future ? undefined : `${count} ${count === 1 ? 'task' : 'tasks'} on ${new Date(year, month, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
								className={cn('min-w-0 flex-1 rounded-[2px]', future && 'border border-dashed border-(--border-default)', day === today && 'shadow-[0_0_0_1px_var(--accent-border)]')}
								style={{
									height: future ? 6 : count ? `${Math.max(18, (count / most) * 100)}%` : 3,
									background: future ? 'transparent' : count ? (day === today ? 'var(--accent-base)' : 'var(--heat-3)') : 'var(--heat-0)',
								}}
							/>
						);
					})}
				</div>
				<div className="grid grid-cols-2 gap-2">
					<div className="flex flex-col rounded-[8px] bg-(--alpha-white-3) px-2.5 py-1.5">
						<span className="text-[11px] text-(--text-tertiary)">Merged</span>
						<span className="in-figure text-[15px] leading-5">{merged}</span>
					</div>
					<div className="flex flex-col rounded-[8px] bg-(--alpha-white-3) px-2.5 py-1.5">
						<span className="text-[11px] text-(--text-tertiary)">Spent</span>
						<span className="in-figure text-[15px] leading-5">{usage.data ? dollars(usage.data.month) : '—'}</span>
					</div>
				</div>
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

/** The picture, credited, in Home's corner: where it comes from and when it changes, which pictures to show (a new one every hour, or NASA's picture of the day), a random other one, and a way to turn the sky off. */
export function SkyCredit() {
	const on = useSkyOn();
	const image: SkyImage = useSky();
	const mode = useSkyMode();
	const next = useNextIn();
	if (!on) return null;
	const day = image.day ? new Date(`${image.day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					aria-label={`Sky: ${image.title}, ${image.credit}`}
					className="sky-credit inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] text-(--text-tertiary) outline-none hover:text-(--text-secondary) focus-visible:shadow-(--focus-ring)"
				>
					<Icon icon={image.day ? Telescope : ImageIcon} size={11} />
					<span className="truncate">{image.title}</span>
					<span className="hidden shrink-0 text-(--text-disabled) sm:inline">· {image.day ? 'Picture of the day' : image.credit}</span>
				</button>
			</MenuTrigger>
			<MenuContent align="end" side="top" className="w-[280px]">
				<MenuLabel>
					<span className="block text-[12px] text-(--text-primary)">{image.title}</span>
					<span className="block font-normal">{image.day ? `${image.credit} · picture of the day for ${day}, until midnight` : `${image.credit} · next picture in ${next}`}</span>
				</MenuLabel>
				<MenuSeparator />
				<MenuItem icon={Clock} checked={mode === 'hourly'} onSelect={(event) => { event.preventDefault(); setSkyMode('hourly'); }}>
					A new picture every hour
				</MenuItem>
				<MenuItem icon={Telescope} checked={mode === 'daily'} onSelect={(event) => { event.preventDefault(); setSkyMode('daily'); }}>
					NASA’s picture of the day
				</MenuItem>
				<MenuItem icon={Shuffle} onSelect={(event) => { event.preventDefault(); shuffleSky(); }}>
					Show a random picture
				</MenuItem>
				<MenuSeparator />
				<SkyBrightnessSlider className="px-2 pt-1 pb-2" />
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
