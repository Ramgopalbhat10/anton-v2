import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, GitPullRequest, type LucideIcon, MessageCircleReply, Play, RotateCcw, Square, Wrench } from 'lucide-react';
import { Caption, Status } from '@/components/instrument';
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

/**
 * A thread as a live card, under the message that started it and in
 * Overview: its glyph, title and state; a mono phase line (repository and
 * for how long) with a sweeping hairline while it works; what
 * it last said with a caret while it types, or its question as an amber
 * quote; and, when it has either, a footer with its pull request and next
 * steps. The whole card opens the thread.
 */
export function ThreadCard({ thread, className }: { thread: Session; className?: string }) {
	const open = useOpenThread();
	const state = stateOf(thread);
	const working = state === 'working';
	const now = useNow(working);
	const since = thread.lastInputAt ?? thread.createdAt;
	const line = threadLine(thread);
	const pr = prSummary(thread);
	const waiting = state === 'waiting';
	const broken = waiting && failed(thread);
	// The pill says the state, so the phase line says only for how long, or when a queued thread starts.
	const ago = age(threadActiveAt(thread));
	const phase = working ? elapsed(now - new Date(since).getTime()) : state === 'queued' ? 'starts when a slot frees' : ago === 'now' ? 'just now' : `${ago} ago`;
	const steps = nextSteps(thread);
	return (
		<article
			aria-label={thread.title}
			onClick={() => open(thread)}
			className={cn(
				'in-card group/thread cursor-pointer overflow-hidden transition-colors duration-(--duration-micro) hover:border-(--border-strong)',
				waiting && !broken && 'border-(--warning-border)',
				broken && 'border-(--danger-border)',
				className,
			)}
		>
			{working ? <div aria-hidden className="in-sweep absolute inset-x-0 top-0 h-px bg-(--accent-border)" /> : null}
			<div className="flex flex-col gap-2 px-3.5 pt-3 pb-3">
				<div className="flex items-center gap-2.5">
					<ThreadGlyph thread={thread} size={16} />
					<div className="min-w-0 flex-1 truncate text-[13.5px] leading-[19px] font-medium text-(--text-primary)">{thread.title}</div>
					<ThreadStatePill thread={thread} />
				</div>
				<div className="flex items-center gap-2 pl-[26px]">
					<Caption className="shrink-0">{repoShort(thread)}</Caption>
					<span aria-hidden className={cn('relative h-px min-w-6 flex-1 overflow-hidden', working ? 'in-sweep bg-(--accent-border)' : 'bg-(--border-subtle)')} />
					<Caption tone={working ? 'accent' : waiting ? (broken ? 'danger' : 'warning') : undefined} className="shrink-0">
						{phase}
					</Caption>
				</div>
				{line ? (
					waiting ? (
						<div
							className={cn(
								'ml-[26px] line-clamp-3 rounded-r-[6px] border-l-2 py-1 pr-2 pl-2.5 text-[12.5px] leading-[18px] text-pretty',
								broken ? 'border-(--danger-base) bg-(--danger-bg) text-(--danger-text)' : 'border-(--warning-base) bg-(--warning-bg) text-(--warning-text)',
							)}
						>
							{line}
						</div>
					) : (
						<div className={cn('line-clamp-2 pl-[26px] text-[12.5px] leading-[18px] text-pretty text-(--text-tertiary)', working && 'agent-live-line')}>
							<span className={working ? 'viz-caret' : undefined}>{line}</span>
						</div>
					)
				) : null}
			</div>
			{pr || steps.length ? (
				<footer className="flex min-h-11 items-center gap-2 border-t border-(--border-subtle) bg-(--well-bg)/40 px-3.5 py-2">
					<div className="flex min-w-0 flex-1 items-center gap-2.5">
						{pr ? (
							<span className="flex min-w-0 items-center gap-1 truncate text-[11.5px] text-(--text-secondary)">
								<Icon icon={GitPullRequest} size={12} className={thread.pullRequest?.checks === 'failed' ? 'text-(--danger-text)' : thread.pullRequest ? 'text-(--success-text)' : 'text-(--icon-tertiary)'} />
								<span className="truncate">{pr}</span>
							</span>
						) : null}
					</div>
					<NextSteps thread={thread} size="xs" />
				</footer>
			) : null}
		</article>
	);
}
