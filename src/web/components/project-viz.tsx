import { prColor } from '@/components/pr-status';
import { useQuery } from '@tanstack/react-query';
import { HoverCard } from 'radix-ui';
import { Activity, Clock, Flame, MessageCircleQuestion } from 'lucide-react';
import { type CSSProperties, type ReactNode } from 'react';
import { Caption, Card, CardSection, ShareRow, Status } from '@/components/instrument';
import { ProjectRouteArt } from '@/components/illustrations';
import { ProjectBay } from '@/components/project-rack';
import { useNow } from '@/components/subagents';
import { NextSteps, prNumber, useOpenThread } from '@/components/thread-card';
import { Glyph, type GlyphKind, glyphKind, KIND_LABEL, KINDS, STATE_COLOR } from '@/components/thread-glyph';
import { api, repoShort, type Session, type Space } from '@/lib/api';
import { age, dollars, elapsed, tokens } from '@/lib/format';
import { stateOf, threadActiveAt, threadLine } from '@/lib/spaces';
import { cn } from '@/lib/utils';

export { KIND_LABEL, KINDS };

export function countKinds(threads: Session[]): Record<GlyphKind, number> {
	const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<GlyphKind, number>;
	for (const thread of threads) counts[glyphKind(thread)] += 1;
	return counts;
}

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const hhmm = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
/** "1h 3m" → "1H 3M", for mono captions. */
const short = (span: number) => elapsed(span).replace(/ \d+s$/, '').toUpperCase();

/**
 * The project's threads as one thin bar split by state, done ones hatched:
 * the project's shape at a glance in the sidebar and on its card.
 */
export function StateSplit({ threads, className, height = 4 }: { threads: Session[]; className?: string; height?: number }) {
	const counts = countKinds(threads);
	const shown = KINDS.filter((kind) => counts[kind] > 0);
	const label = shown.map((kind) => `${counts[kind]} ${KIND_LABEL[kind].toLowerCase()}`).join(', ') || 'No threads';
	return (
		<div role="img" aria-label={label} title={label} className={cn('flex gap-[2px]', className)} style={{ height }}>
			{shown.length ? (
				shown.map((kind) => (
					<span
						key={kind}
						className={cn('min-w-[3px] rounded-[1.5px]', kind === 'resolved' && 'in-hatch text-(--neutral-600)', kind === 'working' && 'in-sweep')}
						style={{ flexGrow: counts[kind], flexBasis: 0, ...(kind === 'resolved' ? { backgroundColor: 'var(--segment-off)' } : { background: STATE_COLOR[kind] }) }}
					/>
				))
			) : (
				<span className="flex-1 rounded-[1.5px] bg-(--segment-off)" />
			)}
		</div>
	);
}

/** Events in the project (threads started, given messages, saved, resolved) binned over the recent stretch: the last six hours at most, half an hour at least. */
export function activity(threads: Session[], now: number, bins = 24) {
	const window = 6 * 3600_000;
	const events = threads.flatMap((thread) => [thread.createdAt, thread.lastInputAt, thread.checkpointAt, thread.resolvedAt].map(ms)).filter((at) => at > now - window && at <= now);
	const earliest = Math.min(...events, now);
	const span = Math.min(window, Math.max(30 * 60_000, (now - earliest) * 1.08));
	const bars = Array.from({ length: bins }, () => 0);
	for (const at of events) bars[Math.min(bins - 1, Math.floor(((at - (now - span)) / span) * bins))] += 1;
	return { bars, span, total: events.length };
}

/** Activity as bars, the current stretch lit in the accent and the busiest one brighter. */
export function ActivityBars({ bars, height = 32, className }: { bars: number[]; height?: number; className?: string }) {
	const max = Math.max(...bars, 1);
	const peak = bars.indexOf(Math.max(...bars));
	return (
		<div role="img" aria-label={`Activity: ${bars.reduce((sum, bar) => sum + bar, 0)} events`} className={cn('flex items-end gap-[2px]', className)} style={{ height }}>
			{bars.map((bar, index) => {
				const last = index === bars.length - 1;
				return (
					<span
						key={index}
						className="min-w-0 flex-1 rounded-[2px] transition-[height] duration-300"
						style={{
							height: bar ? `${Math.max(14, (bar / max) * 100)}%` : 2,
							background: last ? (bar ? 'var(--accent-base)' : 'var(--accent-border)') : bar === 0 ? 'var(--segment-off)' : index === peak ? 'var(--neutral-400)' : 'var(--neutral-600)',
						}}
					/>
				);
			})}
		</div>
	);
}

const threadsWord = (count: number) => `${count} thread${count === 1 ? '' : 's'}`;

/**
 * What the project comes to in a sentence, the most pressing first (it needs
 * you, it works, it waits on review, it is quiet), and a line of what else
 * holds, or when it last moved.
 */
export function pulseLine(threads: Session[], now: number): { headline: string; tone?: 'warning' | 'accent' | 'success'; why: string } {
	const counts = countKinds(threads);
	const needs = counts.waiting + counts.failed;
	const ready = counts.review + counts.landing;
	const open = threads.length - counts.resolved;
	const last = Math.max(...threads.map((thread) => ms(threadActiveAt(thread))).filter((at) => !Number.isNaN(at)));
	const facts = (skip: string) =>
		[
			skip !== 'needs' && needs ? `${needs} need${needs === 1 ? 's' : ''} you` : null,
			skip !== 'working' && counts.working ? `${counts.working} working` : null,
			counts.queued ? `${counts.queued} queued` : null,
			skip !== 'ready' && ready ? `${ready} ready for review` : null,
			skip !== 'idle' && counts.idle ? `${counts.idle} idle` : null,
		].filter(Boolean);
	const ago = Number.isFinite(last) ? age(new Date(last).toISOString(), now) : null;
	const moved = ago === null ? 'Nothing has moved yet' : ago === 'now' ? 'Last moved just now' : `Last moved ${ago} ago`;
	const why = (skip: string) => facts(skip).join(' · ') || moved;
	if (needs) return { headline: `${threadsWord(needs)} need${needs === 1 ? 's' : ''} you`, tone: 'warning', why: why('needs') };
	if (counts.working) return { headline: `${threadsWord(counts.working)} working`, tone: 'accent', why: why('working') };
	if (ready) return { headline: `${threadsWord(ready)} ready for review`, tone: 'success', why: why('ready') };
	if (open) return { headline: 'Quiet, nothing running', why: counts.idle ? `${threadsWord(counts.idle)} idle, waiting for a next step` : moved };
	return { headline: 'All threads resolved', why: moved };
}

/** One thread in the Pulse's strip: a cell in its state's colour that names it on a point and opens it. */
function StripCell({ thread, onOpen }: { thread: Session; onOpen: () => void }) {
	const kind = glyphKind(thread);
	return (
		<HoverCard.Root openDelay={120} closeDelay={80}>
			<HoverCard.Trigger asChild>
				<button
					type="button"
					onClick={onOpen}
					aria-label={`${thread.title}: ${KIND_LABEL[kind]}`}
					className={cn('h-full min-w-[4px] flex-1 rounded-[3px] outline-none hover:brightness-125 focus-visible:shadow-(--focus-ring)', kind === 'resolved' && 'in-hatch text-(--neutral-600)', kind === 'working' && 'in-sweep')}
					style={kind === 'resolved' ? { backgroundColor: 'var(--segment-off)' } : { background: STATE_COLOR[kind] }}
				/>
			</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content side="top" sideOffset={8} collisionPadding={12} className="in-pop z-50 flex w-[260px] flex-col gap-1 px-3 py-2.5 outline-none">
					<span className="flex items-center gap-1.5">
						<Glyph kind={kind} size={12} />
						<span className={cn('in-caption', kind === 'waiting' ? 'text-(--warning-text)' : kind === 'failed' ? 'text-(--danger-text)' : kind === 'working' ? 'text-(--accent-text)' : 'text-(--text-secondary)')}>{KIND_LABEL[kind]}</span>
						<span className="in-caption ml-auto">{age(threadActiveAt(thread))}</span>
					</span>
					<span className="truncate text-[13px] text-(--text-primary)">{thread.title}</span>
					{threadLine(thread) ? <span className="line-clamp-2 text-[12px] leading-[17px] text-(--text-tertiary)">{threadLine(thread)}</span> : null}
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

/**
 * The project's pulse: how many threads are open beside a sentence on what
 * the project comes to; every thread as a cell in a strip, in order of
 * state, with the states counted under it; the project's bay in the rack;
 * and recent activity.
 */
export function ProjectPulse({ space, threads }: { space: Space; threads: Session[] }) {
	const counts = countKinds(threads);
	const live = counts.working > 0;
	const now = useNow(live);
	const open = useOpenThread();
	const { bars, span, total } = activity(threads, now);
	const line = pulseLine(threads, now);
	const strip = [...threads].sort((a, b) => KINDS.indexOf(glyphKind(a)) - KINDS.indexOf(glyphKind(b)) || threadActiveAt(b).localeCompare(threadActiveAt(a)));
	return (
		<Card
			icon={Activity}
			title="Pulse"
			sub={threadsWord(threads.length)}
			status={live ? <Status tone="accent" pulse>Live</Status> : <Status>Quiet</Status>}
		>
			<div className="flex flex-col gap-3 px-4 pt-1 pb-4">
				<div className="flex min-w-0 items-center gap-4">
					<div className="flex shrink-0 flex-col items-start border-r border-(--border-subtle) pr-4">
						<span className="in-figure text-[28px] leading-[30px]">{threads.length - counts.resolved}</span>
						<Caption>open</Caption>
					</div>
					<div className="flex min-w-0 flex-col gap-0.5">
						<span
							className={cn(
								'text-[14px] leading-[20px] font-medium text-pretty',
								line.tone === 'warning' ? 'text-(--warning-text)' : line.tone === 'accent' ? 'text-(--accent-text)' : line.tone === 'success' ? 'text-(--success-text)' : 'text-(--text-primary)',
							)}
						>
							{line.headline}
						</span>
						<span className="text-[12px] leading-[17px] text-(--text-tertiary)">{line.why}</span>
					</div>
				</div>
				<div role="group" aria-label="Threads by state" className="flex h-2.5 gap-[3px]">
					{strip.map((thread) => (
						<StripCell key={thread.id} thread={thread} onOpen={() => open(thread)} />
					))}
				</div>
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					{KINDS.filter((kind) => counts[kind] > 0).map((kind) => (
						<span key={kind} className="flex items-center gap-1.5 text-[12px]">
							<Glyph kind={kind} size={11} />
							<span className={kind === 'waiting' ? 'text-(--warning-text)' : kind === 'failed' ? 'text-(--danger-text)' : 'text-(--text-tertiary)'}>{KIND_LABEL[kind]}</span>
							<span className="in-num text-(--text-primary)">{counts[kind]}</span>
						</span>
					))}
				</div>
			</div>
			<CardSection label="Rack" hint={`${Math.min(counts.working, space.maxParallel)} of ${space.maxParallel} slots working${counts.queued ? ` · ${counts.queued} queued` : ''}`}>
				<ProjectBay space={space} threads={threads} />
			</CardSection>
			<CardSection label={`Activity · last ${short(span)}`} hint={`${total} events`}>
				<div className="flex flex-col gap-1.5">
					<ActivityBars bars={bars} height={36} />
					<div className="flex justify-between">
						<Caption>{hhmm(now - span)}</Caption>
						<Caption tone="accent">now</Caption>
					</div>
				</div>
			</CardSection>
		</Card>
	);
}

/**
 * Threads waiting on you as tracks: your messages and the thread's reply as
 * dots on a line of time, then an amber stretch from its reply to now, the
 * time it has been on you. Longest first.
 */
export function WaitTracks({ threads }: { threads: Session[] }) {
	const open = useOpenThread();
	const now = useNow(false);
	const waiting = threads.filter((thread) => stateOf(thread) === 'waiting').sort((a, b) => threadActiveAt(a).localeCompare(threadActiveAt(b)));
	if (waiting.length === 0) return null;
	const start = Math.min(...waiting.map((thread) => ms(thread.createdAt)));
	const span = Math.max(now - start, 60_000);
	const x = (at: number) => `${Math.min(100, Math.max(0, ((at - start) / span) * 100))}%`;
	return (
		<Card
			icon={MessageCircleQuestion}
			title={`${waiting.length} waiting on you`}
			status={<Caption tone="warning">Longest {age(threadActiveAt(waiting[0]), now)}</Caption>}
			className="border-(--warning-border)"
			footer={
				<footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-(--border-subtle) px-4 py-2.5">
					<span className="flex items-center gap-1.5">
						<span className="size-[7px] rounded-full bg-(--neutral-400)" />
						<Caption>Thread</Caption>
					</span>
					<span className="flex items-center gap-1.5">
						<span className="size-[7px] rounded-full bg-(--accent-base)" />
						<Caption>You</Caption>
					</span>
					<span className="flex items-center gap-1.5">
						<span className="h-[3px] w-3 rounded-full bg-(--warning-base)" />
						<Caption>On you</Caption>
					</span>
					<span className="flex-1" />
					<Caption>Since {hhmm(start)}</Caption>
				</footer>
			}
		>
			<div className="flex flex-col">
				{waiting.map((thread, index) => {
					const reply = ms(threadActiveAt(thread));
					const mine = [ms(thread.createdAt), ms(thread.lastInputAt)].filter((at, i, all) => !Number.isNaN(at) && at < reply && all.indexOf(at) === i);
					const kind = glyphKind(thread);
					const hue = kind === 'failed' ? 'var(--danger-base)' : 'var(--warning-base)';
					return (
						<div key={thread.id} className="viz-in flex flex-col gap-1.5 border-t border-(--border-subtle) px-4 py-2.5" style={{ '--i': index } as CSSProperties}>
							<div className="flex min-w-0 items-center gap-2">
								<Glyph kind={kind} size={13} />
								<button type="button" onClick={() => open(thread)} className="min-w-0 truncate text-left text-[13px] text-(--text-primary) outline-none hover:underline">
									{thread.title}
								</button>
								<Caption className="hidden shrink-0 @min-[420px]/workspace:inline">{repoShort(thread)}</Caption>
								<span className="flex-1" />
								<span className={cn('in-num shrink-0 text-[12px]', index === 0 ? 'text-(--warning-text)' : 'text-(--text-tertiary)')}>{age(threadActiveAt(thread), now)}</span>
								<NextSteps thread={thread} size="xs" />
							</div>
							<div className="relative ml-[21px] h-3">
								<span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-(--border-default)" />
								<span className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full" style={{ left: x(reply), right: 0, background: hue }} />
								<span className="absolute top-0 right-0 bottom-0 border-r border-dashed border-(--border-strong)" />
								{mine.map((at) => (
									<span key={at} className="absolute top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--accent-base) ring-2 ring-(--card-bg)" style={{ left: x(at) }} />
								))}
								<span className="absolute top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--neutral-400) ring-2 ring-(--card-bg)" style={{ left: x(reply) }} />
							</div>
							<div className={cn('ml-[21px] line-clamp-1 text-[12px] leading-[17px]', kind === 'failed' ? 'text-(--danger-text)' : 'text-(--text-tertiary)')}>{threadLine(thread)}</div>
						</div>
					);
				})}
			</div>
		</Card>
	);
}

const DAY = 24 * 3600_000;
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080, 20160].map((minutes) => minutes * 60_000);

/** Round clock times across a stretch, aligned to the local clock: a step from a minute to two weeks, at most five ticks. */
export function ticks(start: number, end: number): { steps: number[]; step: number } {
	const step = STEPS.find((candidate) => (end - start) / candidate <= 5) ?? STEPS[STEPS.length - 1];
	const offset = new Date(start).getTimezoneOffset() * 60_000;
	const first = Math.ceil((start - offset) / step) * step + offset;
	const steps: number[] = [];
	for (let at = first; at <= end; at += step) steps.push(at);
	return { steps, step };
}

/** A tick's label: the day for a step of a day or more and at midnight, else the time. */
export function tickLabel(at: number, step: number): string {
	const date = new Date(at);
	const midnight = date.getHours() === 0 && date.getMinutes() === 0;
	return step >= DAY || midnight ? date.toLocaleDateString([], { month: 'short', day: 'numeric' }) : hhmm(at);
}

/** A title ending in a short " · Oct 22" keeps that end in view when the rest is cut: a routine's runs read apart. */
function TitleWithTail({ title }: { title: string }) {
	const cut = title.lastIndexOf(' · ');
	const tail = cut > 0 ? title.slice(cut + 3) : '';
	if (!tail || tail.length > 12) return <span className="min-w-0 truncate">{title}</span>;
	return (
		<>
			<span className="min-w-0 truncate">{title.slice(0, cut)}</span>
			<span className="shrink-0 text-(--text-tertiary)">· {tail}</span>
		</>
	);
}

/** A bar's label beside it: the side with room. */
function Chip({ at, children, tone, color }: { at: number; children: ReactNode; tone?: 'danger' | 'success'; color?: string }) {
	const right = at > 72;
	return (
		<span
			className={cn(
				'in-caption absolute top-1/2 -translate-y-1/2 rounded-[4px] px-1 text-[9.5px] leading-[15px] whitespace-nowrap',
				tone === 'danger' ? 'bg-(--danger-bg) text-(--danger-text)' : 'bg-(--success-bg) text-(--success-text)',
			)}
			style={{ ...(right ? { right: `calc(${100 - at}% + 6px)` } : { left: `calc(${at}% + 6px)` }), ...(color ? { color, background: 'var(--bg-raised)' } : {}) }}
		>
			{children}
		</span>
	);
}

/**
 * When each thread ran, as a schedule on a clock grid: running bars lit and
 * sweeping, time waiting on you hatched amber up to the now line, failures
 * outlined red with a label, queued threads dashed after now.
 */
export function ScheduleTimeline({ threads }: { threads: Session[] }) {
	const open = useOpenThread();
	const live = threads.some((thread) => stateOf(thread) === 'working');
	const now = useNow(live);
	// What runs, waits or is queued, and what moved in the last three hours, so old threads do not squeeze the bars to slivers.
	const recent = threads.filter((thread) => ['working', 'waiting', 'queued'].includes(stateOf(thread)) || ms(threadActiveAt(thread)) > now - 3 * 3600_000);
	const ranked = [...(recent.length ? recent : threads)].sort((a, b) => Number(stateOf(a) === 'resolved') - Number(stateOf(b) === 'resolved') || threadActiveAt(b).localeCompare(threadActiveAt(a)));
	const shown = ranked.slice(0, 8).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	if (shown.length === 0) return null;
	const counts = countKinds(threads);
	const start = Math.min(...shown.map((thread) => ms(thread.createdAt)), now - 10 * 60_000);
	const past = now - start;
	const end = now + past * (counts.queued ? 0.14 : 0.05);
	const span = end - start;
	const pct = (at: number) => Math.min(100, Math.max(0, ((at - start) / span) * 100));
	const nowAt = pct(now);
	const ran = shown.reduce((sum, thread) => {
		const state = stateOf(thread);
		if (state === 'queued') return sum;
		return sum + Math.max(0, (state === 'working' ? now : ms(threadActiveAt(thread))) - ms(thread.createdAt));
	}, 0);
	const axis = ticks(start, end);
	const left = [counts.working ? `${counts.working} running` : null, counts.failed ? `${counts.failed} failed` : null].filter(Boolean).join(' · ');
	const right = [counts.queued ? `${counts.queued} queued` : null, counts.idle ? `${counts.idle} idle` : null, counts.resolved ? `${counts.resolved} done` : null, counts.review + counts.landing ? `${counts.review + counts.landing} ready` : null].filter(Boolean).join(' · ');
	return (
		<Card
			icon={Clock}
			title="Schedule"
			sub={`${shown.length} of ${threads.length} threads`}
			status={live ? <Status tone="accent" pulse>Live</Status> : <Status>Quiet</Status>}
		>
			<div className="flex items-end justify-between gap-3 border-t border-(--border-subtle) px-4 pt-3 pb-3">
				<div className="flex items-baseline gap-2">
					<span className="in-figure text-[24px] leading-[28px]">{elapsed(ran).replace(/ \d+s$/, '')}</span>
					<span className="text-[12px] text-(--text-tertiary)">thread time</span>
				</div>
				<div className="flex flex-col items-end text-[11.5px] leading-[16px]">
					<span className={counts.failed ? 'text-(--danger-text)' : 'text-(--text-primary)'}>{left || 'nothing running'}</span>
					<span className="text-(--text-tertiary)">{right}</span>
				</div>
			</div>
			<div className="grid grid-cols-[minmax(88px,140px)_minmax(0,1fr)] gap-x-3 border-t border-(--border-subtle) px-4 pt-2.5 pb-3">
				<span />
				<div className="relative h-5">
					{axis.steps.map((at) => (
						<span key={at} className="in-num absolute top-0 -translate-x-1/2 text-[10px] whitespace-nowrap text-(--text-disabled)" style={{ left: `${pct(at)}%` }}>
							{tickLabel(at, axis.step)}
						</span>
					))}
				</div>
				<div className="flex flex-col gap-1.5">
					{shown.map((thread) => {
						const state = stateOf(thread);
						return (
							<button
								key={thread.id}
								type="button"
								onClick={() => open(thread)}
								title={thread.title}
								className={cn('flex h-6 min-w-0 items-center gap-1 text-left font-mono text-[11px] whitespace-nowrap outline-none hover:text-(--text-primary)', state === 'resolved' || state === 'queued' ? 'text-(--text-disabled)' : 'text-(--text-secondary)')}
							>
								<TitleWithTail title={thread.title} />
							</button>
						);
					})}
				</div>
				<div className="relative flex flex-col gap-1.5">
					{axis.steps.map((at) => (
						<span key={at} aria-hidden className="absolute -top-1 -bottom-1 border-l border-dashed border-(--border-subtle)" style={{ left: `${pct(at)}%` }} />
					))}
					<span aria-hidden className="absolute -top-1 -bottom-3 border-l border-dashed border-(--accent-base) opacity-70" style={{ left: `${nowAt}%` }} />
					{shown.map((thread) => {
						const kind = glyphKind(thread);
						const from = pct(ms(thread.createdAt));
						const reply = pct(ms(threadActiveAt(thread)));
						const bar = (a: number, b: number) => ({ left: `${a}%`, width: `max(6px, ${Math.max(0, b - a)}%)` });
						return (
							<button key={thread.id} type="button" onClick={() => open(thread)} aria-label={`${thread.title}: ${KIND_LABEL[kind]}`} className="relative h-6 rounded-[5px] bg-white/[0.025] outline-none focus-visible:shadow-(--focus-ring)">
								{kind === 'working' ? (
									<span className="in-sweep absolute inset-y-[3px] rounded-[4px]" style={{ ...bar(from, nowAt), background: 'linear-gradient(90deg, color-mix(in srgb, var(--accent-base) 22%, transparent), var(--accent-base))' }} />
								) : kind === 'failed' ? (
									<>
										<span className="absolute inset-y-[3px] rounded-[4px] border border-(--danger-base) bg-(--danger-bg)" style={bar(from, Math.max(reply, from + 2))} />
										<Chip at={Math.max(reply, from + 2)} tone="danger">
											{thread.status === 'error' ? 'Failed' : 'CI failing'}
										</Chip>
									</>
								) : kind === 'waiting' ? (
									<>
										<span className="absolute inset-y-[3px] rounded-l-[4px] bg-(--neutral-600)" style={bar(from, reply)} />
										<span className="in-hatch absolute inset-y-[3px] rounded-r-[4px] border border-(--warning-border) bg-(--warning-bg) text-(--warning-base)" style={bar(reply, nowAt)} />
									</>
								) : kind === 'queued' ? (
									<span className="absolute inset-y-[3px] rounded-[4px] border border-dashed border-(--border-strong)" style={bar(nowAt + 0.8, Math.min(99.5, nowAt + 9))} />
								) : kind === 'review' || kind === 'landing' ? (
									<>
										<span className="absolute inset-y-[3px] rounded-[4px]" style={{ ...bar(from, reply), background: 'color-mix(in srgb, var(--success-base) 50%, transparent)' }} />
										{thread.prUrl ? (
											<Chip at={Math.max(reply, from + 1)} color={prColor(thread.pullRequest?.state)}>
												#{prNumber(thread.prUrl)}
											</Chip>
										) : null}
									</>
								) : (
									<span className="absolute inset-y-[3px] rounded-[4px]" style={{ ...bar(from, reply), background: kind === 'resolved' ? 'var(--neutral-700)' : 'var(--neutral-600)' }} />
								)}
							</button>
						);
					})}
				</div>
				<span />
				<div className="relative mt-2 h-5">
					<span
						className="in-caption absolute top-0 -translate-x-1/2 rounded-[5px] border whitespace-nowrap border-(--accent-border) bg-(--accent-bg-subtle) px-1.5 text-(--accent-text)"
						style={{ left: `clamp(36px, ${nowAt}%, calc(100% - 36px))` }}
					>
						Now {hhmm(now)}
					</span>
				</div>
			</div>
			<footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-(--border-subtle) px-4 py-2.5">
				{[
					{ label: 'Done', swatch: <span className="h-2 w-3 rounded-[2px] bg-(--neutral-600)" /> },
					{ label: 'Running', swatch: <span className="h-2 w-3 rounded-[2px] bg-(--accent-base)" /> },
					{ label: 'On you', swatch: <span className="in-hatch h-2 w-3 rounded-[2px] border border-(--warning-border) text-(--warning-base)" /> },
					{ label: 'Failed', swatch: <span className="h-2 w-3 rounded-[2px] border border-(--danger-base) bg-(--danger-bg)" /> },
					{ label: 'Queued', swatch: <span className="h-2 w-3 rounded-[2px] border border-dashed border-(--border-strong)" /> },
				].map((item) => (
					<span key={item.label} className="flex items-center gap-1.5">
						{item.swatch}
						<Caption>{item.label}</Caption>
					</span>
				))}
			</footer>
		</Card>
	);
}

const DATA = ['var(--data-1)', 'var(--data-2)', 'var(--data-3)', 'var(--data-4)', 'var(--data-5)', 'var(--data-6)'];

/** Below a cent a month the work ran on a plan or free models, so tokens say what it did and dollars do not. */
const NEGLIGIBLE_USD = 0.01;

/**
 * What the project costs: the month's figure, the last two weeks as bars with
 * the peak named, and the threads that did most. A project whose spend is
 * negligible (its models on a plan) is measured in tokens instead.
 */
export function BurnCard({ space }: { space: Space }) {
	const usage = useQuery({ queryKey: ['space-usage', space.id], queryFn: () => api.spaceUsage(space.id) });
	const data = usage.data;
	const spent = (data?.byThread ?? []).reduce((sum, item) => sum + item.tokens, 0);
	const byTokens = (data?.month ?? 0) < NEGLIGIBLE_USD && spent > 0;
	const measure = (item: { tokens: number; cost: number }) => (byTokens ? item.tokens : item.cost);
	const format = byTokens ? tokens : dollars;
	const days = Array.from({ length: 14 }, (_, index) => {
		const date = new Date();
		date.setDate(date.getDate() - (13 - index));
		const key = date.toISOString().slice(0, 10);
		const day = data?.daily.find((entry) => entry.day === key);
		return { key, value: day ? measure({ tokens: day.tokens ?? 0, cost: day.cost }) : 0 };
	});
	const max = Math.max(...days.map((day) => day.value), 0.0001);
	const peak = days.reduce((best, day, index) => (day.value > days[best].value ? index : best), 0);
	const byThread = [...(data?.byThread ?? [])].sort((a, b) => measure(b) - measure(a)).slice(0, 4);
	const top = Math.max(...byThread.map(measure), 0.0001);
	return (
		<Card icon={Flame} title="Spend" sub="this month" status={<Caption>Today {dollars(data?.today ?? 0)}</Caption>}>
			<div className="flex flex-col gap-3 px-4 pt-1 pb-4">
				<div className="flex items-baseline gap-2">
					{byTokens ? (
						<>
							<span className="in-figure text-[26px] leading-[30px]">{tokens(spent)}</span>
							<span className="in-num text-[11.5px] text-(--text-tertiary)">tokens · {dollars(data?.month ?? 0)} spent</span>
						</>
					) : (
						<>
							<span className="in-figure text-[26px] leading-[30px]">{dollars(data?.month ?? 0)}</span>
							<span className="in-num text-[11.5px] text-(--text-tertiary)">{tokens(spent)} tok</span>
						</>
					)}
				</div>
				<div role="img" aria-label={`${byTokens ? 'Tokens' : 'Spend'} over the last 14 days`} className="relative flex h-16 items-end gap-[3px] pt-4">
					{days.map((day, index) => {
						const today = index === days.length - 1;
						return (
							<span key={day.key} title={`${day.key}: ${format(day.value)}`} className="relative flex h-full min-w-0 flex-1 items-end">
								{index === peak && day.value > 0 ? (
									<span className="in-num absolute -top-4 left-1/2 -translate-x-1/2 text-[9.5px] whitespace-nowrap text-(--text-secondary)">{format(day.value)}</span>
								) : null}
								<span
									className="w-full rounded-[2px]"
									style={{
										height: day.value ? `${Math.max(8, (day.value / max) * 100)}%` : 2,
										background: today ? 'var(--accent-base)' : index === peak && day.value ? 'var(--neutral-400)' : day.value ? 'var(--neutral-600)' : 'var(--segment-off)',
										boxShadow: today && day.value ? '0 0 12px -2px var(--accent-base)' : undefined,
									}}
								/>
							</span>
						);
					})}
				</div>
				<div className="flex justify-between">
					<Caption>14d ago</Caption>
					<Caption tone="accent">Today</Caption>
				</div>
			</div>
			{byThread.length ? (
				<CardSection label="By thread" hint={byTokens ? 'tokens, share of the top' : 'share of the top'}>
					<div className="flex flex-col">
						{byThread.map((item, index) => (
							<ShareRow
								key={item.id}
								label={
									<span className="flex min-w-0" title={item.title}>
										<TitleWithTail title={item.title} />
									</span>
								}
								sub={byTokens ? dollars(item.cost) : `${tokens(item.tokens)} tok`}
								share={measure(item) / top}
								value={format(measure(item))}
								color={DATA[index % DATA.length]}
							/>
						))}
					</div>
				</CardSection>
			) : null}
		</Card>
	);
}

/**
 * The project's route, drawn as on the New task page: plan, threads, review,
 * done, the stages taking turns and saying what each does.
 */
export function ProjectRoute({ space }: { space: Space }) {
	const stages = [
		{ title: 'Plan', note: 'the coordinator splits the goal' },
		{ title: 'Threads', note: `up to ${space.maxParallel} at once` },
		{ title: 'Review', note: 'pull requests' },
		{ title: 'Done', note: 'merged and resolved' },
	];
	return (
		<div className="in-well in-grid flex flex-col gap-2 px-3 pt-6 pb-4 sm:px-4">
			<ProjectRouteArt className="w-full" />
			<ol aria-label="How the project runs" className="m-0 grid list-none grid-cols-4 p-0">
				{stages.map((stage, index) => (
					<li key={stage.title} className="flex min-w-0 flex-col items-center gap-0.5 px-1 text-center">
						<span className="in-caption route-caption text-(--text-tertiary)" data-first={index === 0 ? true : undefined} style={{ '--stage': index } as CSSProperties}>
							{String(index + 1).padStart(2, '0')} {stage.title}
						</span>
						<div className="line-clamp-2 w-full text-[12px] leading-[16px] text-(--text-secondary)">{stage.note}</div>
					</li>
				))}
			</ol>
		</div>
	);
}
