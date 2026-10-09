import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowUpRight, Copy, GitBranch, GitPullRequest, History, MoreHorizontal, Pencil, Pin, PinOff, ScanSearch, Settings, Square, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/signal';
import { isLive } from '@/components/task-status';
import { api, branchLabel, type PullRequest, type Session } from '@/lib/api';
import { dollars, tokens } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATE: Record<NonNullable<PullRequest['state']>, { label: string; tone: string }> = {
	open: { label: 'Open', tone: 'text-(--success-text)' },
	draft: { label: 'Draft', tone: 'text-(--text-tertiary)' },
	merged: { label: 'Merged', tone: 'text-(--accent-text)' },
	closed: { label: 'Closed', tone: 'text-(--danger-text)' },
};

/** The task's pull request with its state on GitHub; nothing until one is opened. */
export function PullRequestChip({ session }: { session: Session }) {
	const pull = useQuery({
		queryKey: ['pull-request', session.id, session.prUrl],
		queryFn: () => api.pullRequest(session.id),
		enabled: Boolean(session.prUrl),
		staleTime: 60_000,
	});
	if (!session.prUrl) return null;
	const state = pull.data?.state ? STATE[pull.data.state] : null;
	const number = /\/pull\/(\d+)$/.exec(session.prUrl)?.[1];
	return (
		<a
			href={session.prUrl}
			target="_blank"
			rel="noreferrer"
			className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] whitespace-nowrap text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)"
		>
			<Icon icon={GitPullRequest} size={13} className={state?.tone ?? 'text-(--icon-tertiary)'} />
			<span>{number ? `#${number}` : 'Pull request'}</span>
			{state ? <span className={cn('hidden sm:inline', state.tone)}>{state.label}</span> : null}
			<Icon icon={ArrowUpRight} size={12} className="text-(--icon-tertiary)" />
		</a>
	);
}

/** What the task has spent on its model so far; nothing until a response finishes. */
export function UsageChip({ session }: { session: Session }) {
	const { inputTokens, outputTokens, cost } = session.usage;
	if (inputTokens + outputTokens === 0) return null;
	return (
		<span
			className="hidden shrink-0 text-[12px] whitespace-nowrap text-(--text-tertiary) sm:inline"
			title={`Tokens processed over every model call: ${inputTokens.toLocaleString()} input and ${outputTokens.toLocaleString()} output. Each call reads the whole conversation again, so this grows faster than the context window; the meter beside the composer shows how full that is.`}
		>
			{tokens(inputTokens + outputTokens)} processed · {dollars(cost)}
		</span>
	);
}

/** Renames the task, showing the new title at once wherever the task is listed. */
function useRename(session: Session) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (title: string) => api.editSession(session.id, { title }),
		onMutate: (title) => {
			queryClient.setQueryData<Session>(['session', session.id], (current) => current && { ...current, title });
			queryClient.setQueryData<{ sessions: Session[] }>(['sessions'], (current) =>
				current && { sessions: current.sessions.map((task) => (task.id === session.id ? { ...task, title } : task)) },
			);
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['session', session.id] }),
		onSuccess: (updated) => {
			queryClient.setQueryData(['session', updated.id], updated);
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
	});
}

/** The title being edited: Enter or leaving the field saves, Escape cancels. */
export function TitleInput({ session, onDone, className }: { session: Session; onDone: () => void; className?: string }) {
	const rename = useRename(session);
	const save = (value: string) => {
		onDone();
		if (value.trim() && value.trim() !== session.title) rename.mutate(value.trim());
	};
	return (
		<input
			autoFocus
			defaultValue={session.title}
			maxLength={200}
			aria-label="Task title"
			onFocus={(event) => event.currentTarget.select()}
			onBlur={(event) => save(event.currentTarget.value)}
			onKeyDown={(event) => {
				if (event.key === 'Enter') save(event.currentTarget.value);
				if (event.key === 'Escape') onDone();
			}}
			className={cn('h-7 rounded-md bg-(--bg-raised) px-2 text-[13px] text-(--text-primary) outline-none focus-visible:shadow-(--focus-ring)', className)}
		/>
	);
}

/** Click to rename. */
export function TaskTitle({ session, editing, onEditingChange }: { session?: Session; editing: boolean; onEditingChange: (next: boolean) => void }) {
	if (editing && session) return <TitleInput session={session} onDone={() => onEditingChange(false)} className="min-w-[100px] flex-auto font-medium" />;
	return (
		<button
			type="button"
			onClick={() => session && onEditingChange(true)}
			title="Rename task"
			className="min-w-[60px] flex-auto truncate text-left text-[13px] font-medium outline-none"
		>
			{session?.title ?? 'Task'}
		</button>
	);
}

/** Pins the task to the top of the sidebar, or unpins it. */
export function usePin(session: Session) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.editSession(session.id, { pinned: !session.pinnedAt }),
		onSuccess: (updated) => {
			queryClient.setQueryData(['session', updated.id], updated);
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
	});
}

/** Forks the task into a new one with its files, and opens it. */
export function useFork(session: Session) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	return useMutation({
		mutationFn: () => api.forkSession(session.id),
		onSuccess: (fork) => {
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			void navigate({ to: '/agents/$sessionId', params: { sessionId: fork.id }, search: { app: 'code' } });
		},
	});
}

/** Opens the task with its History panel, where any earlier state of the files can be restored. */
export function useRewind(session: Session) {
	const navigate = useNavigate();
	return () => void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code', panel: 'History' } });
}

const taskLink = (session: Session) => new URL(`/agents/${session.id}`, window.location.origin).href;

/** What the task has cost so far, which model it runs on and the branch it works on. */
function TaskFacts({ session }: { session: Session }) {
	const { inputTokens, outputTokens, cost } = session.usage;
	const facts: Array<[string, string]> = [
		['Spend', inputTokens + outputTokens > 0 ? `${dollars(cost)} · ${tokens(inputTokens + outputTokens)}` : dollars(cost)],
		['Model', session.model.split('/').pop() ?? session.model],
		['Branch', branchLabel(session)],
	];
	return (
		<div className="flex max-w-[260px] flex-col gap-1 px-2 pt-1 pb-1.5 text-[11px]">
			{facts.map(([label, value]) => (
				<div key={label} className="flex items-center gap-3">
					<span className="shrink-0 text-(--text-tertiary)">{label}</span>
					<span className="min-w-0 flex-1 truncate text-right text-(--text-secondary)" title={value}>
						{value}
					</span>
				</div>
			))}
		</div>
	);
}

/**
 * Everything to do with a task, in the task header and on each sidebar row:
 * rename, copy its link, pin it, go back to an earlier state, fork it, ask
 * for a pull request or a review of it, open the repo's settings, stop the
 * sandbox, or delete the task. Delete asks twice inside the menu, so a stray
 * click never loses a task.
 */
export function TaskMenu({
	session,
	onRename,
	onAskForPullRequest,
	onOpenChange,
	size = 'sm',
	side = 'bottom',
}: {
	session: Session;
	onRename: () => void;
	/** Only where the task's agent is open, as it asks the agent in the thread. */
	onAskForPullRequest?: () => void;
	onOpenChange?: (open: boolean) => void;
	size?: 'xs' | 'sm';
	/** Beside the trigger in the sidebar, below it in the task header. */
	side?: 'bottom' | 'right';
}) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { sessionId?: string };
	const [confirming, setConfirming] = useState(false);
	const [copied, setCopied] = useState(false);
	const refresh = () => void queryClient.invalidateQueries({ queryKey: ['sessions'] });
	const stop = useMutation({ mutationFn: () => api.stopSession(session.id), onSuccess: refresh });
	const review = useMutation({ mutationFn: () => api.reviewPullRequest(session.id), onSuccess: refresh });
	const pin = usePin(session);
	const fork = useFork(session);
	const rewind = useRewind(session);
	const remove = useMutation({
		mutationFn: async () => {
			if (session.working) await api.stopAgent(session.id).catch(() => undefined);
			await api.deleteSession(session.id);
		},
		onSuccess: () => {
			refresh();
			if (params.sessionId === session.id) void navigate({ to: '/' });
		},
	});

	return (
		<Menu
			onOpenChange={(open) => {
				onOpenChange?.(open);
				if (open) return;
				setConfirming(false);
				setCopied(false);
				review.reset();
			}}
		>
			<MenuTrigger asChild>
				<IconBtn icon={MoreHorizontal} size={size} label="Task actions" />
			</MenuTrigger>
			<MenuContent side={side} align={side === 'right' ? 'start' : 'end'} sideOffset={side === 'right' ? 6 : 4}>
				<MenuItem icon={Pencil} onSelect={onRename}>
					Rename
				</MenuItem>
				{/* Stays open, so it can say the link was copied. */}
				<MenuItem
					icon={Copy}
					onSelect={(event) => {
						event.preventDefault();
						void navigator.clipboard?.writeText(taskLink(session)).then(() => setCopied(true));
					}}
				>
					{copied ? 'Link copied' : 'Copy task link'}
				</MenuItem>
				<MenuItem icon={session.pinnedAt ? PinOff : Pin} onSelect={() => pin.mutate()} disabled={pin.isPending}>
					{session.pinnedAt ? 'Unpin' : 'Pin to top'}
				</MenuItem>
				<MenuSeparator />
				{session.checkpointAt ? (
					<MenuItem icon={History} onSelect={rewind}>
						Rewind to a checkpoint
					</MenuItem>
				) : null}
				<MenuItem icon={GitBranch} onSelect={() => fork.mutate()} disabled={fork.isPending}>
					Fork into a new task
				</MenuItem>
				<MenuSeparator />
				{onAskForPullRequest ? (
					<MenuItem icon={GitPullRequest} onSelect={onAskForPullRequest}>
						{session.prUrl ? 'Update the pull request' : 'Open a pull request'}
					</MenuItem>
				) : null}
				{session.prUrl ? (
					// Stays open, so it can say the review started or why it could not.
					<MenuItem
						icon={ScanSearch}
						disabled={review.isPending || review.isSuccess || session.working}
						onSelect={(event) => {
							event.preventDefault();
							review.mutate();
						}}
					>
						{review.isPending ? 'Starting the review…' : review.isSuccess ? 'Reviewing; it comments on GitHub' : review.isError ? review.error.message : 'Review the pull request'}
					</MenuItem>
				) : null}
				<MenuItem icon={Settings} onSelect={() => void navigate({ to: '/settings/repos/$projectId', params: { projectId: session.projectId } })}>
					Repository settings
				</MenuItem>
				{isLive(session) ? (
					<MenuItem icon={Square} onSelect={() => stop.mutate()} disabled={stop.isPending}>
						Stop sandbox
					</MenuItem>
				) : null}
				<MenuSeparator />
				<MenuItem
					icon={Trash2}
					className="sg-menu-item--destructive"
					disabled={remove.isPending}
					onSelect={(event) => {
						if (!confirming) {
							event.preventDefault();
							setConfirming(true);
							return;
						}
						remove.mutate();
					}}
				>
					{remove.isPending ? 'Deleting…' : confirming ? 'Click again to delete' : 'Delete task'}
				</MenuItem>
				<MenuSeparator />
				<TaskFacts session={session} />
			</MenuContent>
		</Menu>
	);
}
