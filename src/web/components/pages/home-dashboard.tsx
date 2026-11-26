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
import { dollars, when } from '@/lib/format';
import { activeAt, repoName } from '@/lib/task-view';
import { stateOf, threadLine, useSpaces } from '@/lib/spaces';
import { cn } from '@/lib/utils';

const DAY = 86_400_000;
/** Days the outcome instrument covers; the newest seven are this week. */
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

function attentionTone(session: Session): 'danger' | 'warning' | 'accent' {
	if (session.status === 'error' || session.pullRequest?.checks === 'failed' || session.pullRequest?.conflicts) return 'danger';
	if (session.plan) return 'accent';
	return 'warning';
}

const TONE_CLASS = {
	danger: 'bg-(--bad-soft) text-(--bad)',
	warning: 'bg-(--warn-soft) text-(--warn)',
	accent: 'bg-(--accent-soft) text-(--accent-text)',
} as const;

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

function DeckHeading({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="flex h-10 shrink-0 items-center gap-2 px-3.5">
			<h3 className="m-0 text-body font-semibold text-(--text)">{title}</h3>
			<span className="flex-1" />
			{children}
		</div>
	);
}

const MORE = 'inline-flex items-center gap-1 rounded-inner text-small text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)';

function Where({ session, spaces }: { session: Session; spaces?: Array<{ id: string; name: string }> }) {
	const spaceName = session.spaceId ? spaces?.find((space) => space.id === session.spaceId)?.name : undefined;
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

function AttentionRow({ session, spaces }: { session: Session; spaces?: Array<{ id: string; name: string }> }) {
	const tone = attentionTone(session);
	return (
		<TaskLink
			session={session}
			className="group/row flex min-h-12 min-w-0 items-center gap-2.5 px-3.5 py-2 outline-none not-first:border-t not-first:border-(--line) transition-colors duration-(--t-fast) hover:bg-(--bg-hover) focus-visible:shadow-(--focus-inset)"
		>
			<TaskStatusIcon session={session} size={14} />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-body leading-[18px] font-medium text-(--text)">{session.title}</span>
				<span className="truncate text-small leading-4 text-(--text-3)">{session.asking ?? session.errorMessage ?? <Where session={session} spaces={spaces} />}</span>
			</span>
			<span className={cn('shrink-0 rounded-inner px-1.5 py-0.5 text-nano font-medium', TONE_CLASS[tone])}>{nextStep(session)}</span>
			<span className="in-num hidden w-9 shrink-0 text-right text-small text-(--text-3) sm:inline">{when(activeAt(session))}</span>
		</TaskLink>
	);
}

function LiveRow({ session, spaces }: { session: Session; spaces?: Array<{ id: string; name: string }> }) {
	const activity = threadLine(session);
	return (
		<TaskLink
			session={session}
			className="group/row flex min-h-12 min-w-0 items-center gap-2.5 px-3.5 py-2 outline-none not-first:border-t not-first:border-(--line) transition-colors duration-(--t-fast) hover:bg-(--bg-hover) focus-visible:shadow-(--focus-inset)"
		>
			<StatusDot tone="accent" pulse className="ml-[3px]" />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-body leading-[18px] font-medium text-(--text)">{session.title}</span>
				<span className="flex min-w-0 items-center gap-1.5 text-small leading-4 text-(--text-3)">
					{activity ? <span className="truncate">{activity}</span> : <Where session={session} spaces={spaces} />}
				</span>
			</span>
			<PrStatus thread={session} />
			<span className="in-num shrink-0 text-right text-small text-(--text-3)">
				{session.usage.cost > 0 ? `${dollars(session.usage.cost)} · ` : ''}
				{when(session.lastInputAt ?? session.createdAt)}
			</span>
		</TaskLink>
	);
}

function QueueEmpty() {
	return (
		<div className="flex min-h-16 flex-col justify-center px-3.5 py-3 text-small text-(--text-3)">
			<span className="text-(--text-2)">Nothing needs your judgment.</span>
			<span>Anton will surface questions, plans, failures, and conflicts here.</span>
		</div>
	);
}

function NeedsYouDeck({ sessions, spaces }: { sessions: Session[]; spaces?: Array<{ id: string; name: string }> }) {
	const shown = sessions.slice(0, SHOWN);
	return (
		<section aria-label="Needs you" className="border-b border-(--line)">
			<DeckHeading title="Needs you">
				<Badge tone={sessions.length ? 'warning' : 'neutral'}>{sessions.length}</Badge>
				<Link to="/inbox" className={MORE}>
					Open inbox <Icon icon={ArrowRight} size={12} />
				</Link>
			</DeckHeading>
			<div className="border-t border-(--line)">
				{shown.length ? shown.map((session) => <AttentionRow key={session.id} session={session} spaces={spaces} />) : <QueueEmpty />}
			</div>
		</section>
	);
}

function RunningDeck({ sessions, spaces }: { sessions: Session[]; spaces?: Array<{ id: string; name: string }> }) {
	const shown = sessions.slice(0, SHOWN);
	return (
		<section aria-label="Running">
			<DeckHeading title="Running">
				<StatusDot tone={sessions.length ? 'accent' : 'neutral'} pulse={sessions.length > 0} />
				<span className="in-num text-small text-(--text-3)">{sessions.length}</span>
			</DeckHeading>
			<div className="border-t border-(--line)">
				{shown.length ? (
					shown.map((session) => <LiveRow key={session.id} session={session} spaces={spaces} />)
				) : (
					<div className="flex min-h-14 items-center px-3.5 text-small text-(--text-3)">Nothing is running right now.</div>
				)}
			</div>
		</section>
	);
}

function OutcomeStat({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
			<span className="text-micro leading-4 text-(--text-3)">{label}</span>
			<span className="in-num truncate text-body-lg leading-5 font-semibold text-(--text)">{value}</span>
			{detail ? <span className="truncate text-nano leading-3.5 text-(--text-4)">{detail}</span> : null}
		</div>
	);
}

function Outcomes({ sessions }: { sessions: Session[] }) {
	const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage, staleTime: 60_000 });
	const { perDay, week, merged, openPrs } = useMemo(() => {
		const today = localDay(new Date());
		const perDay = Array.from({ length: DAYS }, () => 0);
		let week = 0;
		let merged = 0;
		let openPrs = 0;
		for (const session of sessions) {
			if (session.pullRequest?.state === 'open' || session.pullRequest?.state === 'draft') openPrs += 1;
			const back = today - localDay(new Date(session.createdAt));
			if (back < 0 || back >= DAYS) continue;
			perDay[DAYS - 1 - back] += 1;
			if (back < 7) {
				week += 1;
				if (session.pullRequest?.state === 'merged') merged += 1;
			}
		}
		return { perDay, week, merged, openPrs };
	}, [sessions]);
	const most = Math.max(1, ...perDay);
	return (
		<section aria-label="This week" className="border-b border-(--line)">
			<DeckHeading title="Outcomes">
				<span className="text-small text-(--text-3)">14 days</span>
			</DeckHeading>
			<div className="grid grid-cols-3 divide-x divide-(--line) border-t border-(--line)">
				<OutcomeStat label="Started" value={week} detail="this week" />
				<OutcomeStat label="Merged" value={merged} detail={openPrs ? `${openPrs} open` : 'none open'} />
				<OutcomeStat label="Spent" value={usage.data ? dollars(usage.data.month) : '—'} detail="this month" />
			</div>
			<div className="flex h-16 items-end gap-[3px] border-t border-(--line) px-3.5 pt-3 pb-3" role="img" aria-label={`Tasks started on each of the last ${DAYS} days`}>
				{perDay.map((count, index) => {
					const back = DAYS - 1 - index;
					return (
						<span
							key={index}
							title={`${count} ${count === 1 ? 'task' : 'tasks'} ${back === 0 ? 'today' : back === 1 ? 'yesterday' : `${back} days ago`}`}
							className={cn('min-w-0 flex-1 rounded-mark', back < 7 && count > 0 ? 'bg-(--accent)' : 'bg-(--bg-active)')}
							style={{ height: 5 + Math.round((count / most) * 30) }}
						/>
					);
				})}
			</div>
		</section>
	);
}

function stateColor(session: Session): string {
	const state = stateOf(session);
	if (state === 'waiting') return 'var(--warn)';
	if (state === 'working' || state === 'queued') return 'var(--accent)';
	if (state === 'review' || state === 'landing') return 'var(--ok)';
	return 'var(--text-4)';
}

function WorkloadMap({ sessions }: { sessions: Session[] }) {
	const spaces = useSpaces();
	const lanes = useMemo(() => {
		const groups = new Map<string, { key: string; label: string; sessions: Session[] }>();
		for (const session of sessions) {
			const space = session.spaceId ? spaces.data?.spaces.find((item) => item.id === session.spaceId) : undefined;
			const key = session.spaceId ?? session.repo ?? 'chat';
			const label = space?.name ?? (session.repo ? repoName(session.repo) : 'Chat');
			const group = groups.get(key) ?? { key, label, sessions: [] };
			group.sessions.push(session);
			groups.set(key, group);
		}
		return [...groups.values()]
			.map((group) => ({
				...group,
				waiting: group.sessions.filter(needsYou).length,
				running: group.sessions.filter(isRunning).length,
				latest: Math.max(...group.sessions.map((session) => Date.parse(activeAt(session)) || 0)),
			}))
			.sort((a, b) => b.waiting + b.running - (a.waiting + a.running) || b.latest - a.latest)
			.slice(0, 5);
	}, [sessions, spaces.data]);
	return (
		<section aria-label="Workload map" className="flex min-h-0 flex-1 flex-col">
			<DeckHeading title="Workload map">
				<span className="flex items-center gap-2 text-nano text-(--text-3)">
					<span className="flex items-center gap-1"><StatusDot color="var(--warn)" /> waiting</span>
					<span className="flex items-center gap-1"><StatusDot color="var(--accent)" /> active</span>
				</span>
			</DeckHeading>
			<div className="flex min-h-0 flex-1 flex-col border-t border-(--line)">
				{lanes.map((lane) => (
					<div key={lane.key} className="flex min-h-11 flex-1 items-center gap-3 px-3.5 py-2 not-first:border-t not-first:border-(--line)">
						<div className="flex min-w-0 flex-1 flex-col gap-1">
							<span className="truncate text-small font-medium text-(--text-2)">{lane.label}</span>
							<span className="flex min-w-0 items-center gap-1" aria-label={`${lane.sessions.length} tasks in ${lane.label}`}>
								{lane.sessions.slice(0, 12).map((session) => (
									<span key={session.id} title={session.title} className="h-2.5 w-1.5 rounded-mark" style={{ background: stateColor(session) }} />
								))}
								{lane.sessions.length > 12 ? <span className="text-nano text-(--text-4)">+{lane.sessions.length - 12}</span> : null}
							</span>
						</div>
						<span className="in-num shrink-0 text-small text-(--text-3)">{lane.sessions.length}</span>
					</div>
				))}
			</div>
		</section>
	);
}

function RecentDeck({ sessions, spaces }: { sessions: Session[]; spaces?: Array<{ id: string; name: string }> }) {
	return (
		<section aria-label="Recent" className="border-t border-(--line) bg-(--bg-panel)">
			<DeckHeading title="Recent">
				<Link to="/tasks" className={MORE}>
					All tasks <Icon icon={ArrowRight} size={12} />
				</Link>
			</DeckHeading>
			<div className="grid border-t border-(--line) lg:grid-cols-5">
				{sessions.map((session) => (
					<TaskLink
						key={session.id}
						session={session}
						className="group/row flex min-h-14 min-w-0 items-center gap-2.5 px-3.5 py-2 outline-none not-first:border-t not-first:border-(--line) transition-colors duration-(--t-fast) hover:bg-(--bg-hover) focus-visible:shadow-(--focus-inset) lg:not-first:border-t-0 lg:not-first:border-l"
					>
						<TaskStatusIcon session={session} size={14} />
						<span className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="truncate text-small leading-4 font-medium text-(--text)">{session.title}</span>
							<span className="flex min-w-0 items-center gap-1 text-micro leading-3.5 text-(--text-3)">
								<Where session={session} spaces={spaces} />
								<span className="text-(--text-4)">·</span>
								<span className="in-num shrink-0">{when(activeAt(session))}</span>
							</span>
						</span>
					</TaskLink>
				))}
			</div>
		</section>
	);
}

function FirstRun() {
	const steps = [
		['Describe the outcome', 'Use plain language; attach files or images when they help.'],
		['Watch Anton work', 'Follow the plan, terminal, files, and preview while it runs.'],
		['Review the result', 'Check the diff, ask for changes, or open a pull request.'],
	] as const;
	return (
		<section aria-label="How Anton works" className="in-card flex flex-col gap-4 px-4 py-4">
			<div className="flex flex-col gap-1">
				<h2 className="m-0 text-body-lg font-semibold text-(--text)">Start with one outcome</h2>
				<p className="m-0 max-w-[56ch] text-small leading-5 text-(--text-2)">Anton works in an isolated branch and sandbox, keeps you in control of consequential actions, and returns work you can inspect before it lands.</p>
			</div>
			<ol className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-3">
				{steps.map(([title, body], index) => (
					<li key={title} className="flex min-w-0 gap-2.5 rounded-inner bg-(--bg-active) px-3 py-2.5">
						<span aria-hidden className="in-num flex size-5 shrink-0 items-center justify-center rounded-full bg-(--accent-soft) text-nano font-semibold text-(--accent-text)">{index + 1}</span>
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="text-small font-medium text-(--text)">{title}</span>
							<span className="text-small leading-4 text-(--text-3)">{body}</span>
						</span>
					</li>
				))}
			</ol>
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
	const spaces = useSpaces();
	const { needs, running, recent, all } = useMemo(() => {
		const all = sessions.data?.sessions ?? [];
		const byActive = [...all].sort((a, b) => activeAt(b).localeCompare(activeAt(a)));
		const needs = byActive.filter(needsYou);
		const running = byActive.filter((session) => isRunning(session) && !needsYou(session));
		const listed = new Set([...needs, ...running].map((session) => session.id));
		return { needs, running, recent: byActive.filter((session) => !listed.has(session.id)).slice(0, SHOWN), all };
	}, [sessions.data]);
	if (!sessions.data) return null;
	if (all.length === 0) return <FirstRun />;
	return (
		<section aria-label="Control deck" className="overflow-hidden rounded-card bg-(--bg-surface) shadow-[inset_0_0_0_1px_var(--line)]">
			<div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--line) px-3.5 py-2">
				<h2 className="m-0 text-body-lg leading-5 font-semibold text-(--text)">Control deck</h2>
				<span className="text-small text-(--text-3)">Attention, active work, and outcomes in one scan</span>
				<span className="flex-1" />
				<span className="flex items-center gap-2 text-small text-(--text-3)">
					<span className="flex items-center gap-1.5"><StatusDot color="var(--warn)" /> {needs.length} waiting</span>
					<span className="flex items-center gap-1.5"><StatusDot color="var(--accent)" pulse={running.length > 0} /> {running.length} running</span>
				</span>
			</div>
			<div className="grid lg:grid-cols-[minmax(0,1.42fr)_minmax(300px,0.82fr)]">
				<div className="min-w-0">
					<NeedsYouDeck sessions={needs} spaces={spaces.data?.spaces} />
					<RunningDeck sessions={running} spaces={spaces.data?.spaces} />
				</div>
				<div className="flex min-w-0 flex-col border-t border-(--line) lg:border-t-0 lg:border-l">
					<Outcomes sessions={all} />
					<WorkloadMap sessions={all} />
				</div>
			</div>
			{recent.length ? <RecentDeck sessions={recent} spaces={spaces.data?.spaces} /> : null}
		</section>
	);
}
