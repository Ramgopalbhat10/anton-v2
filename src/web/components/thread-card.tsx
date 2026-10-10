import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, CircleAlert, GitPullRequest, type LucideIcon, MessageCircleReply, Play, RotateCcw, Square, Wrench } from 'lucide-react';
import { Caption, Status } from '@/components/instrument';
import { Btn, Icon, Spinner } from '@/components/signal';
import { useNow } from '@/components/subagents';
import { api, type Session, type ThreadState } from '@/lib/api';
import { age, dollars, elapsed, tokens } from '@/lib/format';
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

/** The state as an icon, for list rows: a spinner while it works. */
export function ThreadStateIcon({ thread, size = 13 }: { thread: Session; size?: number }) {
	const state = stateOf(thread);
	if (state === 'working') return <Spinner size={size} />;
	if (state === 'waiting' && failed(thread)) return <Icon icon={CircleAlert} size={size} className="text-(--danger-text)" />;
	const look = STATE_LOOK[state];
	const tone = { warning: 'text-(--warning-text)', success: 'text-(--success-text)', accent: 'text-(--accent-text)', neutral: 'text-(--icon-tertiary)', danger: 'text-(--danger-text)' }[look.tone];
	return <Icon icon={look.icon} size={size} className={tone} />;
}

export const prNumber = (url: string | null) => (url ? (/\/pull\/(\d+)/.exec(url)?.[1] ?? null) : null);

/** The pull request in a few words: number, state and checks. */
export function prSummary(thread: Session): string | null {
	if (!thread.prUrl) return null;
	const pr = thread.pullRequest;
	const name = `#${prNumber(thread.prUrl) ?? '?'}`;
	if (!pr) return `${name} opened`;
	if (pr.state === 'merged' || pr.state === 'closed') return `${name} ${pr.state}`;
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
 * A thread as a card, under the message that started it and in Overview:
 * its repository and age in mono, the title, its state, one line of what it
 * asks or last said, and a footer with its pull request, spend and next steps.
 * The whole card opens the thread.
 */
export function ThreadCard({ thread, className }: { thread: Session; className?: string }) {
	const open = useOpenThread();
	const state = stateOf(thread);
	const working = state === 'working';
	const now = useNow(working);
	const since = thread.lastInputAt ?? thread.createdAt;
	const line = threadLine(thread);
	const pr = prSummary(thread);
	const spent = thread.usage.inputTokens + thread.usage.outputTokens;
	const waiting = state === 'waiting';
	const broken = waiting && failed(thread);
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
			<div className="flex flex-col gap-1.5 px-3.5 pt-3 pb-3">
				<div className="flex items-center gap-2">
					<Caption className="min-w-0 flex-1 truncate">
						{thread.repo.split('/').pop()} · {working ? `working ${elapsed(now - new Date(since).getTime())}` : age(threadActiveAt(thread))}
					</Caption>
					<ThreadStatePill thread={thread} />
				</div>
				<div className="truncate text-[13.5px] leading-[19px] font-medium text-(--text-primary)">{thread.title}</div>
				{line ? (
					<div
						className={cn(
							'line-clamp-2 text-[12.5px] leading-[18px] text-pretty',
							broken ? 'text-(--danger-text)' : waiting ? 'text-(--warning-text)' : 'text-(--text-tertiary)',
							working && 'agent-live-line',
						)}
					>
						<span>{line}</span>
					</div>
				) : null}
			</div>
			<footer className="flex min-h-11 items-center gap-2 border-t border-(--border-subtle) px-3.5 py-2">
				<div className="flex min-w-0 flex-1 items-center gap-2.5">
					{pr ? (
						<span className="flex min-w-0 items-center gap-1 truncate text-[11.5px] text-(--text-secondary)">
							<Icon icon={GitPullRequest} size={12} className={thread.pullRequest?.checks === 'failed' ? 'text-(--danger-text)' : thread.pullRequest ? 'text-(--success-text)' : 'text-(--icon-tertiary)'} />
							<span className="truncate">{pr}</span>
						</span>
					) : null}
					{spent > 0 ? (
						<Caption className="shrink-0 whitespace-nowrap">
							{tokens(spent)} tok · {dollars(thread.usage.cost)}
						</Caption>
					) : state === 'queued' ? (
						<Caption>Starts when a slot frees</Caption>
					) : null}
				</div>
				<NextSteps thread={thread} size="xs" />
			</footer>
		</article>
	);
}
