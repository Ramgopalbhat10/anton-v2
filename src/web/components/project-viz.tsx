import { useQuery } from '@tanstack/react-query';
import { Activity, Clock, Flame, MessageCircleQuestion } from 'lucide-react';
import { type CSSProperties, type ReactNode } from 'react';
import { Caption, Card, CardSection, ShareRow, Status } from '@/components/instrument';
import { ProjectRouteArt } from '@/components/illustrations';
import { ProjectBay } from '@/components/project-rack';
import { useNow } from '@/components/subagents';
import { NextSteps, prNumber, useOpenThread } from '@/components/thread-card';
import { Glyph, type GlyphKind, glyphKind, KIND_LABEL, KINDS, STATE_COLOR } from '@/components/thread-glyph';
import { api, type Session, type Space } from '@/lib/api';
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

/** One blade per parallel slot, lit while a thread holds it: how full the project runs. */
export function SlotPips({ space, threads }: { space: Space; threads: Session[] }) {
	const counts = countKinds(threads);
	const busy = Math.min(counts.working, space.maxParallel);
	const label = `${busy} of ${space.maxParallel} slots working${counts.queued ? `, ${counts.queued} queued` : ''}`;
	return (
		<span className="flex shrink-0 items-center gap-2" title={label}>
			<span role="img" aria-label={label} className="flex items-center gap-[3px]">
				{Array.from({ length: space.maxParallel }, (_, index) => (
					<span key={index} className={cn('h-3 w-[5px] rounded-[1.5px]', index < busy ? 'in-pulse bg-(--accent-base)' : 'bg-(--segment-off)')} style={{ animationDelay: `${index * 200}ms` }} />
				))}
			</span>
			<span className="in-num text-[11px] text-(--text-tertiary)">
				{busy}/{space.maxParallel}
			</span>
			{counts.queued ? <Caption>+{counts.queued} queued</Caption> : null}
			{counts.waiting + counts.failed ? (
				<span className="flex items-center gap-1 rounded-full border border-(--warning-border) bg-(--warning-bg) px-1.5 text-[11px] leading-[18px] text-(--warning-text)">
					<span className="size-1.5 rounded-full bg-(--warning-base)" />
					{counts.waiting + counts.failed} need{counts.waiting + counts.failed === 1 ? 's' : ''} you
				</span>
			) : null}
		</span>
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

/** Arcs of a ring, each a share of the whole with a small gap between them. */
function arcs(values: Array<{ key: string; value: number; color: string; className?: string }>, radius: number, gap: number) {
	const circumference = 2 * Math.PI * radius;
	const total = values.reduce((sum, item) => sum + item.value, 0);
	const shown = values.filter((item) => item.value > 0);
	let offset = 0;
	return shown.map((item) => {
		const length = (item.value / total) * circumference;
		const arc = { ...item, dash: `${Math.max(0.5, length - (shown.length > 1 ? gap : 0))} ${circumference}`, offset: -offset };
		offset += length;
		return arc;
	});
}

/**
 * The project as a ring: the outer ring split by state, the inner one by
 * parallel slots, lit while threads hold them, and what is open in the
 * middle.
 */
function StateRing({ threads, maxParallel, size = 128 }: { threads: Session[]; maxParallel: number; size?: number }) {
	const counts = countKinds(threads);
	const c = size / 2;
	const outer = c - 6;
	const inner = c - 19;
	const open = threads.length - counts.resolved;
	const busy = Math.min(counts.working, maxParallel);
	const states = arcs(
		KINDS.map((kind) => ({ key: kind, value: counts[kind], color: kind === 'resolved' ? 'var(--neutral-600)' : STATE_COLOR[kind] })),
		outer,
		3,
	);
	const slots = arcs(
		Array.from({ length: maxParallel }, (_, index) => ({ key: String(index), value: 1, color: index < busy ? 'var(--accent-base)' : 'var(--segment-off)', className: index < busy ? 'in-pulse' : undefined })),
		inner,
		4,
	);
	return (
		<div className="relative shrink-0" style={{ width: size, height: size }}>
			<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
				<circle cx={c} cy={c} r={outer} fill="none" stroke="var(--segment-off)" strokeWidth={9} />
				{states.map((arc) => (
					<circle key={arc.key} cx={c} cy={c} r={outer} fill="none" stroke={arc.color} strokeWidth={9} strokeDasharray={arc.dash} strokeDashoffset={arc.offset} transform={`rotate(-90 ${c} ${c})`} />
				))}
				{slots.map((arc) => (
					<circle
						key={arc.key}
						className={arc.className}
						cx={c}
						cy={c}
						r={inner}
						fill="none"
						stroke={arc.color}
						strokeWidth={3}
						strokeLinecap="round"
						strokeDasharray={arc.dash}
						strokeDashoffset={arc.offset}
						transform={`rotate(-90 ${c} ${c})`}
					/>
				))}
			</svg>
			<div className="absolute inset-0 flex flex-col items-center justify-center">
				<span className="in-figure text-[30px] leading-[32px]">{open}</span>
				<Caption>open</Caption>
				<span className="in-num mt-0.5 text-[10.5px] text-(--text-disabled)">{counts.resolved} done</span>
			</div>
		</div>
	);
}

/** The project's pulse: the ring and its legend, the project's bay in the rack, and recent activity. */
export function ProjectPulse({ space, threads }: { space: Space; threads: Session[] }) {
	const counts = countKinds(threads);
	const live = counts.working > 0;
	const now = useNow(live);
	const { bars, span, total } = activity(threads, now);
	return (
		<Card
			icon={Activity}
			title="Pulse"
			sub={`${threads.length} thread${threads.length === 1 ? '' : 's'}`}
			status={live ? <Status tone="accent" pulse>Live</Status> : <Status>Quiet</Status>}
		>
			<div className="flex items-center gap-5 px-4 pt-1 pb-4">
				<StateRing threads={threads} maxParallel={space.maxParallel} />
				<div className="flex min-w-0 flex-1 flex-col">
					{KINDS.filter((kind) => counts[kind] > 0).map((kind) => (
						<div key={kind} className="flex h-[26px] items-center gap-2 border-b border-dashed border-(--border-subtle) last:border-b-0">
							<Glyph kind={kind} size={12} />
							<span className={cn('min-w-0 flex-1 truncate text-[12px]', kind === 'waiting' ? 'text-(--warning-text)' : kind === 'failed' ? 'text-(--danger-text)' : 'text-(--text-secondary)')}>{KIND_LABEL[kind]}</span>
							<span className="in-num text-[12px] text-(--text-primary)">{counts[kind]}</span>
						</div>
					))}
				</div>
			</div>
			<CardSection label="Rack · point at a blade" hint={`${Math.min(counts.working, space.maxParallel)} of ${space.maxParallel} slots working${counts.queued ? ` · ${counts.queued} queued` : ''}`}>
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
								<Caption className="hidden shrink-0 @min-[420px]/workspace:inline">{thread.repo.split('/').pop()}</Caption>
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

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * 60_000);

/** Round clock times across a stretch, aligned to the local clock. */
function ticks(start: number, end: number): number[] {
	const step = STEPS.find((candidate) => (end - start) / candidate <= 5) ?? STEPS[STEPS.length - 1];
	const offset = new Date(start).getTimezoneOffset() * 60_000;
	const first = Math.ceil((start - offset) / step) * step + offset;
	const out: number[] = [];
	for (let at = first; at <= end; at += step) out.push(at);
	return out;
}

/** A bar's label beside it: the side with room. */
function Chip({ at, children, tone }: { at: number; children: ReactNode; tone: 'danger' | 'success' }) {
	const right = at > 72;
	return (
		<span
			className={cn(
				'in-caption absolute top-1/2 -translate-y-1/2 rounded-[4px] px-1 text-[9.5px] leading-[15px] whitespace-nowrap',
				tone === 'danger' ? 'bg-(--danger-bg) text-(--danger-text)' : 'bg-(--success-bg) text-(--success-text)',
			)}
			style={right ? { right: `calc(${100 - at}% + 6px)` } : { left: `calc(${at}% + 6px)` }}
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
	const left = [counts.working ? `${counts.working} running` : null, counts.failed ? `${counts.failed} failed` : null].filter(Boolean).join(' · ');
	const right = [counts.queued ? `${counts.queued} queued` : null, counts.resolved + counts.idle ? `${counts.resolved + counts.idle} done` : null, counts.review + counts.landing ? `${counts.review + counts.landing} ready` : null].filter(Boolean).join(' · ');
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
			<div className="grid grid-cols-[minmax(72px,104px)_minmax(0,1fr)] gap-x-3 border-t border-(--border-subtle) px-4 pt-2.5 pb-3">
				<span />
				<div className="relative h-5">
					{ticks(start, end).map((at) => (
						<span key={at} className="in-num absolute top-0 -translate-x-1/2 text-[10px] text-(--text-disabled)" style={{ left: `${pct(at)}%` }}>
							{hhmm(at)}
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
								className={cn('h-6 truncate text-left font-mono text-[11px] outline-none hover:text-(--text-primary)', state === 'resolved' || state === 'queued' ? 'text-(--text-disabled)' : 'text-(--text-secondary)')}
							>
								{thread.title}
							</button>
						);
					})}
				</div>
				<div className="relative flex flex-col gap-1.5">
					{ticks(start, end).map((at) => (
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
											<Chip at={Math.max(reply, from + 1)} tone="success">
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

/** What the project costs: the month's figure, the last two weeks as bars with the peak named, and the threads that spent most. */
export function BurnCard({ space }: { space: Space }) {
	const usage = useQuery({ queryKey: ['space-usage', space.id], queryFn: () => api.spaceUsage(space.id) });
	const data = usage.data;
	const days = Array.from({ length: 14 }, (_, index) => {
		const date = new Date();
		date.setDate(date.getDate() - (13 - index));
		const key = date.toISOString().slice(0, 10);
		return { key, cost: data?.daily.find((day) => day.day === key)?.cost ?? 0 };
	});
	const max = Math.max(...days.map((day) => day.cost), 0.0001);
	const peak = days.reduce((best, day, index) => (day.cost > days[best].cost ? index : best), 0);
	const byThread = [...(data?.byThread ?? [])].sort((a, b) => b.cost - a.cost).slice(0, 4);
	const top = Math.max(...byThread.map((item) => item.cost), 0.0001);
	const spent = (data?.byThread ?? []).reduce((sum, item) => sum + item.tokens, 0);
	return (
		<Card icon={Flame} title="Spend" sub="this month" status={<Caption>Today {dollars(data?.today ?? 0)}</Caption>}>
			<div className="flex flex-col gap-3 px-4 pt-1 pb-4">
				<div className="flex items-baseline gap-2">
					<span className="in-figure text-[26px] leading-[30px]">{dollars(data?.month ?? 0)}</span>
					<span className="in-num text-[11.5px] text-(--text-tertiary)">{tokens(spent)} tok</span>
				</div>
				<div role="img" aria-label="Spend over the last 14 days" className="relative flex h-16 items-end gap-[3px] pt-4">
					{days.map((day, index) => {
						const today = index === days.length - 1;
						return (
							<span key={day.key} title={`${day.key}: ${dollars(day.cost)}`} className="relative flex h-full min-w-0 flex-1 items-end">
								{index === peak && day.cost > 0 ? (
									<span className="in-num absolute -top-4 left-1/2 -translate-x-1/2 text-[9.5px] whitespace-nowrap text-(--text-secondary)">{dollars(day.cost)}</span>
								) : null}
								<span
									className="w-full rounded-[2px]"
									style={{
										height: day.cost ? `${Math.max(8, (day.cost / max) * 100)}%` : 2,
										background: today ? 'var(--accent-base)' : index === peak && day.cost ? 'var(--neutral-400)' : day.cost ? 'var(--neutral-600)' : 'var(--segment-off)',
										boxShadow: today && day.cost ? '0 0 12px -2px var(--accent-base)' : undefined,
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
				<CardSection label="By thread" hint="share of the top">
					<div className="flex flex-col">
						{byThread.map((item, index) => (
							<ShareRow key={item.id} label={item.title} sub={`${tokens(item.tokens)} tok`} share={item.cost / top} value={dollars(item.cost)} color={DATA[index % DATA.length]} />
						))}
					</div>
				</CardSection>
			) : null}
		</Card>
	);
}

/**
 * The project's route, drawn as on the New task page: plan, threads, review,
 * done. `live` lights the stations that have work now and puts the counts
 * under them; without it the stages take turns and say what each does.
 */
export function ProjectRoute({ space, threads, coordinating, live }: { space: Space; threads: Session[]; coordinating?: boolean; live?: boolean }) {
	const counts = countKinds(threads);
	const running = counts.working + counts.queued + counts.waiting + counts.failed;
	const ready = counts.review + counts.landing;
	const finished = counts.resolved + counts.idle;
	const needs = counts.waiting + counts.failed;
	const active = [Boolean(coordinating), running > 0, ready > 0, finished > 0];
	const stages: Array<{ title: string; note: ReactNode }> = live
		? [
				{ title: 'Plan', note: coordinating ? 'coordinating now' : 'coordinator idle' },
				{
					title: 'Threads',
					note: running ? (
						<>
							{needs ? <span className="text-(--warning-text)">{needs} need{needs === 1 ? 's' : ''} you</span> : null}
							{[counts.working ? `${counts.working} working` : null, counts.queued ? `${counts.queued} queued` : null]
								.filter(Boolean)
								.map((part, index) => (needs || index ? ` · ${part}` : part))}
						</>
					) : (
						'none running'
					),
				},
				{ title: 'Review', note: ready ? `${ready} ready` : 'nothing to review' },
				{ title: 'Done', note: `${finished} done` },
			]
		: [
				{ title: 'Plan', note: 'the coordinator splits the goal' },
				{ title: 'Threads', note: `up to ${space.maxParallel} at once` },
				{ title: 'Review', note: 'pull requests' },
				{ title: 'Done', note: 'merged and resolved' },
			];
	return (
		<div className="in-well in-grid flex flex-col gap-2 px-3 pt-6 pb-4 sm:px-4">
			<ProjectRouteArt className="w-full" active={live ? active : undefined} waiting={live ? needs > 0 : true} />
			<ol aria-label="How the project runs" className="m-0 grid list-none grid-cols-4 p-0">
				{stages.map((stage, index) => (
					<li key={stage.title} className="flex min-w-0 flex-col items-center gap-0.5 px-1 text-center">
						<span
							className={cn('in-caption', live ? (active[index] ? 'text-(--accent-text)' : 'text-(--text-tertiary)') : 'route-caption text-(--text-tertiary)')}
							data-first={!live && index === 0 ? true : undefined}
							style={live ? undefined : ({ '--stage': index } as CSSProperties)}
						>
							{String(index + 1).padStart(2, '0')} {stage.title}
						</span>
						<div className={cn('line-clamp-2 w-full text-[12px] leading-[16px]', live && !active[index] ? 'text-(--text-disabled)' : 'text-(--text-secondary)')}>{stage.note}</div>
					</li>
				))}
			</ol>
		</div>
	);
}
