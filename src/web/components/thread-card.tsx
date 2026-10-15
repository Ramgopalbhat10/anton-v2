import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, GitPullRequest, type LucideIcon, MessageCircleReply, Play, RotateCcw, Square, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { HoverPeek } from '@/components/hover-peek';
import { Caption, Chip, Status } from '@/components/instrument';
import { Btn, Icon } from '@/components/signal';
import { useNow } from '@/components/subagents';
import { ThreadGlyph } from '@/components/thread-glyph';
import { api, repoShort, type Session, type ThreadState } from '@/lib/api';
import { age, elapsed } from '@/lib/format';
import { failed, STATE_LOOK, stateOf, threadActiveAt, threadLine } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/** The state in a word with its dot, as on a card or a row: amber needs you, cyan works, emerald is ready. */
export function ThreadStatePill({ thread, compact }: { thread: Session; compact?: boolean }) {
	const state = stateOf(thread);
	const look = STATE_LOOK[state];
	const broken = state === 'waiting' && failed(thread);
	const label = broken ? (thread.status === 'error' ? 'Failed' : 'Checks failing') : compact ? look.short : look.label;
	return (
		<Status tone={broken ? 'danger' : look.tone === 'neutral' ? 'neutral' : look.tone} pulse={state === 'working'}>
			{label}
		</Status>
	);
}

/** The state as a drawn glyph, for list rows: a turning ring while it works, a calling dot while it waits on you. */
export function ThreadStateIcon({ thread, size = 13 }: { thread: Session; size?: number }) {
	return <ThreadGlyph thread={thread} size={size} />;
}

export const prNumber = (url: string | null) => (url ? (/\/pull\/(\d+)/.exec(url)?.[1] ?? null) : null);

/** The pull request in a few words: number, state and checks. */
export function prSummary(thread: Session): string | null {
	if (!thread.prUrl) return null;
	const pr = thread.pullRequest;
	const name = `#${prNumber(thread.prUrl) ?? '?'}`;
	if (!pr) return `${name} opened`;
	if (pr.state === 'merged' || pr.state === 'closed') return `${name} ${pr.state}`;
	if (pr.conflicts) return `${name} · merge conflicts`;
	if (pr.checks === 'failed') return `${name} · checks failing`;
	if (pr.checks === 'pending') return `${name} · checks running`;
	if (pr.approved) return `${name} · approved`;
	return `${name} · ${pr.state === 'draft' ? 'draft' : pr.checks === 'passed' ? 'checks pass' : 'open'}`;
}

type Step = { label: string; icon: LucideIcon; primary?: boolean } & ({ send: string } | { open: true; panel?: 'Changes' } | { stop: true } | { href: string });

/** The next steps a thread offers in its state; each sends that instruction to the thread, as if you typed it. */
export function nextSteps(thread: Session): Step[] {
	const state: ThreadState = stateOf(thread);
	const pr = thread.prUrl ? thread.pullRequest : null;
	if (state === 'working') return [{ label: 'Stop', icon: Square, stop: true }];
	if (state === 'queued') return [];
	if (thread.status === 'error') return [{ label: 'Try again', icon: RotateCcw, send: 'Something failed. Look at what went wrong and try again.', primary: true }];
	if (pr?.conflicts && !thread.review) return [{ label: 'Fix conflicts', icon: Wrench, send: 'The pull request has merge conflicts. Merge the latest base branch with merge_base_branch, resolve them, check the result and update the pull request.', primary: true }];
	if (pr?.checks === 'failed') return [{ label: 'Fix CI', icon: Wrench, send: 'Checks are failing on the pull request. Find out why, fix it and push.', primary: true }];
	if (state === 'waiting') return [{ label: 'Answer', icon: MessageCircleReply, open: true, primary: true }];
	if (state === 'review') return [{ label: 'Review', icon: GitPullRequest, open: true, panel: 'Changes', primary: true }, ...(thread.prUrl ? [{ label: 'PR', icon: ArrowUpRight, href: thread.prUrl }] : [])];
	if (state === 'landing' && thread.prUrl) return [{ label: 'Open PR', icon: ArrowUpRight, href: thread.prUrl, primary: true }];
	if (state === 'idle' && thread.workspace && !thread.prUrl) return [{ label: 'Create PR', icon: GitPullRequest, send: 'Open a pull request with the changes on this branch. Write a clear title and a short description.' }];
	return [];
}

/** Opens a project's thread in the main view, with one of its panels when asked. */
export function useOpenThread() {
	const navigate = useNavigate();
	return (thread: Session, panel?: 'Changes') => {
		if (!thread.spaceId) return void navigate({ to: '/agents/$sessionId', params: { sessionId: thread.id }, search: { app: 'code', panel } });
		void navigate({ to: '/projects/$spaceId/threads/$threadId', params: { spaceId: thread.spaceId, threadId: thread.id }, search: { panel } });
	};
}

/** The card's buttons: each next step, plus opening the thread. */
export function NextSteps({ thread, size = 'sm' }: { thread: Session; size?: 'sm' | 'xs' }) {
	const queryClient = useQueryClient();
	const open = useOpenThread();
	const send = useMutation({
		mutationFn: async (step: Step) => {
			if ('send' in step && thread.spaceId) await api.nudgeThread(thread.spaceId, thread.id, step.send);
			if ('stop' in step) await api.stopAgent(thread.id);
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
	});
	const steps = nextSteps(thread);
	return (
		<div className="flex shrink-0 items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
			{steps.map((step) =>
				'href' in step ? (
					<a key={step.label} href={step.href} target="_blank" rel="noreferrer" className={cn('sg-btn', `sg-btn--${size}`, step.primary ? 'sg-btn--secondary' : 'sg-btn--ghost')}>
						<Icon icon={step.icon} size={size === 'xs' ? 12 : 14} />
						<span>{step.label}</span>
					</a>
				) : (
					<Btn
						key={step.label}
						size={size}
						variant={step.primary ? 'secondary' : 'ghost'}
						icon={step.icon}
						disabled={send.isPending}
						onClick={() => ('open' in step ? open(thread, step.panel) : send.mutate(step))}
					>
						{step.label}
					</Btn>
				),
			)}
			{size === 'sm' ? (
				<Btn size="sm" variant="ghost" icon={Play} onClick={() => open(thread)} aria-label={`Open ${thread.title}`}>
					Open
				</Btn>
			) : null}
		</div>
	);
}

/** A pull request's state as a chip colour: merged violet, failing red, conflicted amber, open green. */
function prTone(thread: Session): { tone?: 'success' | 'danger' | 'warning'; color?: string; title: string } {
	const pr = thread.pullRequest;
	const title = prSummary(thread) ?? '';
	if (!pr) return { title };
	if (pr.state === 'merged') return { color: 'var(--data-2)', title };
	if (pr.state === 'closed') return { title };
	if (pr.checks === 'failed') return { tone: 'danger', title };
	if (pr.conflicts) return { tone: 'warning', title };
	return { tone: pr.state === 'draft' ? undefined : 'success', title };
}

/**
 * What a row says beyond its glyph and title, as chips: its pull request,
 * and its state only where the glyph alone would not do (it needs you, it
 * failed, it waits for a slot). Everything else is in the peek.
 */
export function ThreadChips({ thread }: { thread: Session }) {
	const state = stateOf(thread);
	const number = prNumber(thread.prUrl);
	const pr = prTone(thread);
	const checksFailing = thread.pullRequest?.checks === 'failed';
	return (
		<>
			{thread.prUrl ? (
				<Chip icon={GitPullRequest} mono tone={pr.tone} color={pr.color} title={pr.title}>
					#{number ?? '?'}
				</Chip>
			) : null}
			{thread.status === 'error' ? (
				<Chip tone="danger">Failed</Chip>
			) : state === 'waiting' && !checksFailing ? (
				<Chip tone="warning">Needs you</Chip>
			) : state === 'queued' ? (
				<Chip>Queued</Chip>
			) : null}
		</>
	);
}

/** How long it has worked, or how long since it last did anything. */
function phaseOf(thread: Session, now: number): string {
	const state = stateOf(thread);
	if (state === 'working') return elapsed(now - new Date(thread.lastInputAt ?? thread.createdAt).getTime());
	if (state === 'queued') return 'starts when a slot frees';
	const ago = age(threadActiveAt(thread), now);
	return ago === 'now' ? 'just now' : `${ago} ago`;
}

/**
 * Everything a row leaves out, on hover: its state, where it works and for
 * how long, what it last said or asks, its pull request, and its next steps.
 */
export function ThreadPeek({ thread }: { thread: Session }) {
	const open = useOpenThread();
	const state = stateOf(thread);
	const now = useNow(state === 'working');
	const line = threadLine(thread);
	const waiting = state === 'waiting';
	const broken = waiting && failed(thread);
	const pr = prSummary(thread);
	return (
		<>
			<div className="flex items-start gap-2">
				<span className="mt-[2px] inline-flex shrink-0">
					<ThreadGlyph thread={thread} size={14} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="line-clamp-2 text-[13px] leading-[18px] font-medium text-(--text-primary)">{thread.title}</span>
					<span className="flex min-w-0 items-center gap-2">
						<ThreadStatePill thread={thread} />
						<Caption className="truncate">
							{repoShort(thread)} · {phaseOf(thread, now)}
						</Caption>
					</span>
				</div>
			</div>
			{line ? (
				waiting ? (
					<div
						className={cn(
							'line-clamp-4 rounded-r-[6px] border-l-2 py-1 pr-2 pl-2.5 text-[12.5px] leading-[18px] text-pretty',
							broken ? 'border-(--danger-base) bg-(--danger-bg) text-(--danger-text)' : 'border-(--warning-base) bg-(--warning-bg) text-(--warning-text)',
						)}
					>
						{line}
					</div>
				) : (
					<p className={cn('m-0 line-clamp-3 text-[12.5px] leading-[18px] text-pretty text-(--text-tertiary)', state === 'working' && 'agent-live-line')}>{line}</p>
				)
			) : null}
			{pr && thread.prUrl ? (
				<a
					href={thread.prUrl}
					target="_blank"
					rel="noreferrer"
					className="flex min-w-0 items-center gap-1.5 self-start text-[12px] text-(--text-secondary) outline-none hover:text-(--text-primary) hover:underline focus-visible:shadow-(--focus-ring)"
				>
					<Icon icon={GitPullRequest} size={12} className={thread.pullRequest?.checks === 'failed' ? 'text-(--danger-text)' : 'text-(--icon-tertiary)'} />
					<span className="truncate">{pr}</span>
					<Icon icon={ArrowUpRight} size={11} className="text-(--icon-tertiary)" />
				</a>
			) : null}
			<div className="flex flex-wrap items-center gap-1.5 border-t border-(--border-subtle) pt-2.5">
				<NextSteps thread={thread} size="xs" />
				<span className="flex-1" />
				<Btn size="xs" variant="ghost" icon={Play} onClick={() => open(thread)}>
					Open thread
				</Btn>
			</div>
		</>
	);
}

/**
 * A thread in a reply, on one line: its glyph, title and chips, and how long
 * ago or for how long; a thread that needs you adds what it asks underneath
 * and its next step. Resting on it shows the rest; clicking opens it.
 * `ThreadRows` stacks them in one card.
 */
export function ThreadRow({ thread }: { thread: Session }) {
	const open = useOpenThread();
	const state = stateOf(thread);
	const now = useNow(state === 'working');
	const waiting = state === 'waiting';
	const broken = waiting && failed(thread);
	const line = waiting ? threadLine(thread) : '';
	return (
		<HoverPeek content={<ThreadPeek thread={thread} />}>
			<article
				aria-label={thread.title}
				onClick={() => open(thread)}
				className="group/thread flex min-w-0 cursor-pointer flex-col justify-center gap-0.5 px-3 py-2 transition-colors duration-(--duration-micro) hover:bg-(--bg-hover)"
			>
				<div className="flex min-h-6 min-w-0 items-center gap-2.5">
					<ThreadGlyph thread={thread} size={14} />
					<span className="min-w-0 truncate text-[13px] text-(--text-primary)">{thread.title}</span>
					<span className="flex shrink-0 items-center gap-1">
						<ThreadChips thread={thread} />
					</span>
					<span className="flex-1" />
					<span className={cn('in-num shrink-0 text-[11px]', state === 'working' ? 'text-(--accent-text)' : 'text-(--text-disabled)', !waiting && nextSteps(thread).length && 'sm:group-focus-within/thread:hidden sm:group-hover/thread:hidden')}>
						{state === 'queued' ? '' : phaseOf(thread, now)}
					</span>
					{waiting ? (
						<NextSteps thread={thread} size="xs" />
					) : (
						// Its next steps take the place of its age on hover, so a row at rest says only what it is.
						<span className="hidden sm:group-focus-within/thread:flex sm:group-hover/thread:flex">
							<NextSteps thread={thread} size="xs" />
						</span>
					)}
				</div>
				{line ? <span className={cn('truncate pl-[24px] text-[12px] leading-[17px]', broken ? 'text-(--danger-text)' : 'text-(--warning-text)')}>{line}</span> : null}
			</article>
		</HoverPeek>
	);
}

/** Threads in a reply: one card, a line each. */
export function ThreadRows({ children, label }: { children: ReactNode; label?: string }) {
	return (
		<section aria-label={label} className="in-card flex flex-col divide-y divide-(--border-subtle) overflow-hidden">
			{children}
		</section>
	);
}

/**
 * A thread named in the middle of a sentence: its glyph and title as a chip,
 * the same peek on hover, and a click opens it.
 */
export function ThreadChip({ thread, children }: { thread: Session; children?: ReactNode }) {
	const open = useOpenThread();
	return (
		<HoverPeek content={<ThreadPeek thread={thread} />}>
			<button
				type="button"
				onClick={() => open(thread)}
				className="mx-px inline-flex max-w-full items-center gap-1 rounded-[6px] bg-(--alpha-white-6) px-1.5 align-baseline text-[0.95em] leading-[1.5] text-(--accent-text) outline-none hover:bg-(--alpha-white-9) focus-visible:shadow-(--focus-ring)"
			>
				<span className="inline-flex shrink-0 self-center">
					<ThreadGlyph thread={thread} size={11} />
				</span>
				<span className="truncate">{children ?? thread.title}</span>
			</button>
		</HoverPeek>
	);
}
