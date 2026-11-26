import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from '@/lib/icons';
import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { Badge, Icon } from '@/components/kit/signal';
import { TaskStatusIcon } from '@/components/marks/task-status';
import { api, SAFETY_NET_MS } from '@/lib/api';
import type { Session } from '@/lib/api/sessions';
import { dollars, when } from '@/lib/format';
import { activeAt, repoName } from '@/lib/task-view';
import { stateOf, useSpaces } from '@/lib/spaces';
import { cn } from '@/lib/utils';

const DAY = 86_400_000;
const DAYS = 14;
const ATTENTION_SHOWN = 5;
const LANES_SHOWN = 5;
const NODES_SHOWN = 10;

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

function TaskLink({ session, children, className, style }: { session: Session; children: ReactNode; className?: string; style?: CSSProperties }) {
	return session.spaceId ? (
		<Link to="/projects/$spaceId/threads/$threadId" params={{ spaceId: session.spaceId, threadId: session.id }} className={className} style={style}>
			{children}
		</Link>
	) : (
		<Link to="/agents/$sessionId" params={{ sessionId: session.id }} search={{ app: 'code' }} className={className} style={style}>
			{children}
		</Link>
	);
}

function SectionTitle({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="mb-3 flex h-6 items-center gap-2">
			<h2 className="m-0 text-body-lg leading-5 font-semibold text-(--text)">{title}</h2>
			{children}
		</div>
	);
}

const MORE = 'ml-auto inline-flex items-center gap-1 rounded-inner text-small text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)';

function placeLabel(session: Session, spaces?: Array<{ id: string; name: string }>): string {
	const spaceName = session.spaceId ? spaces?.find((space) => space.id === session.spaceId)?.name : undefined;
	return spaceName ?? (session.repo ? repoName(session.repo) : 'Chat');
}

function AttentionItem({ session, spaces }: { session: Session; spaces?: Array<{ id: string; name: string }> }) {
	const tone = attentionTone(session);
	const detail = session.asking ?? session.errorMessage ?? session.plan ?? session.brief ?? 'Open the thread to see what changed.';
	return (
		<TaskLink
			session={session}
			className="group/item relative flex min-w-0 gap-3 rounded-control py-2 pr-2 pl-7 outline-none transition-colors duration-(--t-fast) hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
		>
			<span className="absolute top-[15px] left-0 flex size-5 items-center justify-center rounded-full border border-(--line) bg-(--bg-surface)">
				<TaskStatusIcon session={session} size={12} />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate text-body font-medium text-(--text)">{session.title}</span>
					<span className="in-num shrink-0 text-small text-(--text-3)">{when(activeAt(session))}</span>
				</span>
				<span className="line-clamp-2 max-w-[68ch] text-small leading-5 text-(--text-2)">{detail}</span>
				<span className="flex min-w-0 items-center gap-2 text-small text-(--text-3)">
					<span className="truncate">{placeLabel(session, spaces)}</span>
					{session.branch ? <span className="hidden min-w-0 truncate font-mono text-micro sm:inline">· {session.branch}</span> : null}
				</span>
			</span>
			<span className={cn('mt-0.5 h-fit shrink-0 rounded-inner px-1.5 py-0.5 text-nano font-medium', TONE_CLASS[tone])}>{nextStep(session)}</span>
		</TaskLink>
	);
}

function Attention({ sessions, spaces }: { sessions: Session[]; spaces?: Array<{ id: string; name: string }> }) {
	const shown = sessions.slice(0, ATTENTION_SHOWN);
	return (
		<section aria-label="Needs you">
			<SectionTitle title="Needs you">
				<Badge tone="warning">{sessions.length}</Badge>
				<Link to="/inbox" className={MORE}>
					Open inbox <Icon icon={ArrowRight} size={12} />
				</Link>
			</SectionTitle>
			<div className="relative flex flex-col gap-1 pl-2 before:absolute before:top-5 before:bottom-5 before:left-[19px] before:w-px before:bg-(--line)">
				{shown.map((session) => (
					<AttentionItem key={session.id} session={session} spaces={spaces} />
				))}
			</div>
			{sessions.length > shown.length ? (
				<Link to="/tasks" className="mt-1 inline-flex items-center gap-1 rounded-inner px-2 py-1 text-small text-(--text-3) outline-none hover:text-(--text) focus-visible:shadow-(--focus)">
					{sessions.length - shown.length} more waiting <Icon icon={ArrowRight} size={12} />
				</Link>
			) : null}
		</section>
	);
}

function laneTone(session: Session): string {
	const state = stateOf(session);
	if (state === 'waiting') return 'var(--warn)';
	if (state === 'working' || state === 'queued') return 'var(--accent)';
	if (state === 'review' || state === 'landing') return 'var(--ok)';
	return 'var(--text-4)';
}

function laneSummary(sessions: Session[]): string {
	const waiting = sessions.filter(needsYou).length;
	const active = sessions.filter(isRunning).length;
	if (waiting && active) return `${waiting} waiting · ${active} active`;
	if (waiting) return `${waiting} waiting`;
	if (active) return `${active} active`;
	return `${sessions.length} quiet`;
}

function WorkNode({ session, index, total, offset, span }: { session: Session; index: number; total: number; offset: number; span: number }) {
	const left = total === 1 ? 50 : offset + (index / (total - 1)) * span;
	const hot = needsYou(session) || isRunning(session);
	return (
		<TaskLink
			session={session}
			className={cn(
				'absolute top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none transition-transform duration-(--t-fast) hover:scale-115 focus-visible:shadow-(--focus)',
				hot ? 'bg-(--bg-surface)' : 'bg-transparent',
			)}
			style={{ left: `${left}%`, boxShadow: hot ? `0 0 0 1px var(--line), 0 0 14px color-mix(in srgb, ${laneTone(session)} 24%, transparent)` : undefined }}
		>
			<span className="sr-only">{session.title}</span>
			<span aria-hidden title={session.title} className="flex size-4 items-center justify-center rounded-full" style={{ color: laneTone(session) }}>
				<TaskStatusIcon session={session} size={13} />
			</span>
		</TaskLink>
	);
}

function WorkMap({ sessions }: { sessions: Session[] }) {
	const spaces = useSpaces();
	const lanes = useMemo(() => {
		const groups = new Map<string, { key: string; label: string; sessions: Session[] }>();
		const today = localDay(new Date());
		const current = sessions.filter((session) => needsYou(session) || isRunning(session) || today - localDay(new Date(activeAt(session))) < DAYS);
		for (const session of current) {
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
				sessions: [...group.sessions].sort((a, b) => activeAt(a).localeCompare(activeAt(b))),
				latest: Math.max(...group.sessions.map((session) => Date.parse(activeAt(session)) || 0)),
			}))
			.sort((a, b) => b.latest - a.latest)
			.slice(0, LANES_SHOWN);
	}, [sessions, spaces.data]);
	if (!lanes.length) return null;
	return (
		<section aria-label="Work map" className="rounded-card px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--line)]">
			<div className="mb-2 flex items-center gap-2">
				<h2 className="m-0 text-body-lg leading-5 font-semibold text-(--text)">Work map</h2>
				<span className="text-small text-(--text-3)">projects as lanes · latest work at the right</span>
				<span className="flex-1" />
				<span className="hidden items-center gap-2 text-nano text-(--text-3) sm:flex">
					<span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-(--warn)" /> waiting</span>
					<span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-(--accent)" /> active</span>
				</span>
			</div>
			<div className="flex flex-col gap-1">
				{lanes.map((lane) => {
					const nodes = lane.sessions.slice(-NODES_SHOWN);
					const hidden = lane.sessions.length - nodes.length;
					return (
						<div key={lane.key} className="grid min-h-9 grid-cols-[92px_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[132px_minmax(0,1fr)_112px]">
							<div className="flex min-w-0 flex-col">
								<span className="truncate text-small font-medium text-(--text-2)">{lane.label}</span>
								<span className="truncate text-nano text-(--text-4) sm:hidden">{laneSummary(lane.sessions)}</span>
							</div>
							<div className="relative h-8 min-w-0" role="group" aria-label={`${lane.sessions.length} tasks in ${lane.label}; ${laneSummary(lane.sessions)}`}>
								<span aria-hidden className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-(--line)" />
								{nodes.map((session, index) => (
									<WorkNode key={session.id} session={session} index={index} total={nodes.length} offset={hidden ? 9 : 4} span={hidden ? 83 : 88} />
								))}
								{hidden ? <span className="in-num absolute top-1/2 left-0 -translate-y-1/2 rounded-inner bg-(--bg-active) px-1 py-px text-nano text-(--text-3)">+{hidden}</span> : null}
							</div>
							<span className="hidden truncate text-right text-small text-(--text-3) sm:block">{laneSummary(lane.sessions)}</span>
						</div>
					);
				})}
			</div>
		</section>
	);
}

function Momentum({ sessions }: { sessions: Session[] }) {
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
		<section aria-label="Momentum" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
			<p className="m-0 text-small leading-5 text-(--text-2)">
				<strong className="in-num font-semibold text-(--text)">{week}</strong> started this week
				<span className="text-(--text-4)"> · </span>
				<strong className="in-num font-semibold text-(--text)">{merged}</strong> merged
				{openPrs ? (
					<>
						<span className="text-(--text-4)"> · </span>
						<strong className="in-num font-semibold text-(--text)">{openPrs}</strong> open {openPrs === 1 ? 'PR' : 'PRs'}
					</>
				) : null}
				<span className="text-(--text-4)"> · </span>
				<strong className="in-num font-semibold text-(--text)">{usage.data ? dollars(usage.data.month) : '—'}</strong>{' '}this month
			</p>
			<span className="flex-1" />
			<div role="img" aria-label={`Tasks started on each of the last ${DAYS} days`} className="flex h-6 w-36 items-end gap-[3px]">
				{perDay.map((count, index) => {
					const back = DAYS - 1 - index;
					return (
						<span
							key={index}
							title={`${count} ${count === 1 ? 'task' : 'tasks'} ${back === 0 ? 'today' : back === 1 ? 'yesterday' : `${back} days ago`}`}
							className={cn('min-w-0 flex-1 rounded-mark', back < 7 && count > 0 ? 'bg-(--accent)' : 'bg-(--bg-active)')}
							style={{ height: 4 + Math.round((count / most) * 20) }}
						/>
					);
				})}
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
	const { needs, all } = useMemo(() => {
		const all = sessions.data?.sessions ?? [];
		const byActive = [...all].sort((a, b) => activeAt(b).localeCompare(activeAt(a)));
		return { needs: byActive.filter(needsYou), all };
	}, [sessions.data]);
	if (!sessions.data) return null;
	if (all.length === 0) return <FirstRun />;
	return (
		<div className="mx-auto flex w-full max-w-[920px] flex-col gap-6">
			{needs.length ? <Attention sessions={needs} spaces={spaces.data?.spaces} /> : null}
			<WorkMap sessions={all} />
			<Momentum sessions={all} />
		</div>
	);
}
