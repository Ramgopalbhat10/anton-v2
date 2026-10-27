import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { CircleCheck, Copy, FolderKanban, FolderMinus, GitBranch, GitPullRequest, History, MoreHorizontal, Pencil, Pin, PinOff, RotateCcw, ScanSearch, Settings, Square, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { PrStatus } from '@/components/pr-status';
import { ProjectIcon } from '@/components/project-icon';
import { Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '@/components/signal';
import { isLive } from '@/components/task-status';
import { api, branchLabel, isChat, type Session } from '@/lib/api';
import { dollars, tokens } from '@/lib/format';
import { useSpaces } from '@/lib/spaces';
import { cn } from '@/lib/utils';

/** The task's pull request, refreshed independently when the header is open. */
export function PullRequestChip({ session }: { session: Session }) {
	const pull = useQuery({ queryKey: ['pull-request', session.id, session.prUrl], queryFn: () => api.pullRequest(session.id), enabled: Boolean(session.prUrl), staleTime: 60_000 });
	const state = pull.data?.state;
	const snapshot = session.pullRequest;
	const pullRequest = state ? { ...(snapshot ?? { checks: null, runs: [] }), state } : snapshot;
	return <PrStatus thread={{ prUrl: session.prUrl, pullRequest }} link full className="h-7 rounded-lg px-2 outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)" />;
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

const taskLink = (session: Session) => new URL(session.spaceId ? `/projects/${session.spaceId}/threads/${session.id}` : `/agents/${session.id}`, window.location.origin).href;

/** Moving a task into a project makes it a thread there; out of one, an ordinary task again. Done threads fold away in the project. */
function ProjectItems({ session }: { session: Session }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { sessionId?: string; threadId?: string };
	const spaces = useSpaces();
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		void queryClient.invalidateQueries({ queryKey: ['spaces'] });
	};
	const move = useMutation({
		mutationFn: (spaceId: string | null) => api.editSession(session.id, { spaceId }),
		onSuccess: (_, spaceId) => {
			refresh();
			const here = params.sessionId === session.id || params.threadId === session.id;
			if (!here) return;
			if (spaceId) void navigate({ to: '/projects/$spaceId/threads/$threadId', params: { spaceId, threadId: session.id } });
			else void navigate({ to: '/agents/$sessionId', params: { sessionId: session.id }, search: { app: 'code' } });
		},
	});
	const resolve = useMutation({ mutationFn: (resolved: boolean) => api.editSession(session.id, { resolved }), onSuccess: refresh });
	const others = (spaces.data?.spaces ?? []).filter((space) => space.id !== session.spaceId && space.state !== 'archived');
	return (
		<>
			{/* Any task can be done, as a project's thread can: the sidebar and the project show the same states. */}
			<MenuItem icon={session.resolvedAt ? RotateCcw : CircleCheck} disabled={resolve.isPending} onSelect={() => resolve.mutate(!session.resolvedAt)}>
				{session.resolvedAt ? (session.spaceId ? 'Reopen thread' : 'Reopen') : 'Mark done'}
			</MenuItem>
			{/* A task's repository joins the project's; a chat stays a chat, as threads of a project without repositories are. */}
			{others.length ? (
				<MenuSub>
					<MenuSubTrigger icon={FolderKanban}>{session.spaceId ? 'Move to another project' : 'Move to project'}</MenuSubTrigger>
					<MenuSubContent>
						{others.map((space) => (
							<MenuItem key={space.id} onSelect={() => move.mutate(space.id)}>
								<span className="flex min-w-0 items-center gap-2">
									<ProjectIcon value={space.icon} name={space.name} size={16} />
									<span className="truncate">{space.name}</span>
								</span>
							</MenuItem>
						))}
					</MenuSubContent>
				</MenuSub>
			) : null}
			{session.spaceId ? (
				<MenuItem icon={FolderMinus} disabled={move.isPending} onSelect={() => move.mutate(null)}>
					Remove from project
				</MenuItem>
			) : null}
		</>
	);
}

/** What the task has cost so far, which model it runs on and the branch it works on. */
function TaskFacts({ session }: { session: Session }) {
	const { inputTokens, outputTokens, cost } = session.usage;
	const facts: Array<[string, string]> = [
		['Spend', inputTokens + outputTokens > 0 ? `${dollars(cost)} · ${tokens(inputTokens + outputTokens)}` : dollars(cost)],
		['Model', session.model.split('/').pop() ?? session.model],
		[isChat(session) ? 'Sandbox' : 'Branch', branchLabel(session)],
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
	const params = useParams({ strict: false }) as { sessionId?: string; threadId?: string };
	const [confirming, setConfirming] = useState(false);
	const [copied, setCopied] = useState(false);
	const repoId = session.projectId;
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
			// A deleted thread leaves its project's feed too, and its files show in the project's Library.
			if (session.spaceId) void queryClient.invalidateQueries({ queryKey: ['space-files', session.spaceId] });
			if (params.threadId === session.id && session.spaceId) void navigate({ to: '/projects/$spaceId', params: { spaceId: session.spaceId } });
			else if (params.sessionId === session.id) void navigate({ to: '/' });
		},
	});
	const thread = Boolean(session.spaceId);
	// As in Claude's projects, a resolved thread is the project's record: it is reopened before it can go.
	const locked = thread && Boolean(session.resolvedAt);

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
				<ProjectItems session={session} />
				<MenuSeparator />
				{onAskForPullRequest && !isChat(session) ? (
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
				{repoId ? (
					<MenuItem icon={Settings} onSelect={() => void navigate({ to: '/settings/repos/$projectId', params: { projectId: repoId } })}>
						Repository settings
					</MenuItem>
				) : null}
				{isLive(session) ? (
					<MenuItem icon={Square} onSelect={() => stop.mutate()} disabled={stop.isPending}>
						Stop sandbox
					</MenuItem>
				) : null}
				{/* Without any of the items above, one rule is enough. */}
				{(onAskForPullRequest && !isChat(session)) || session.prUrl || repoId || isLive(session) ? <MenuSeparator /> : null}
				<MenuItem
					icon={Trash2}
					className="sg-menu-item--destructive"
					disabled={remove.isPending || locked}
					hint={locked ? 'Reopen first' : undefined}
					onSelect={(event) => {
						if (!confirming) {
							event.preventDefault();
							setConfirming(true);
							return;
						}
						remove.mutate();
					}}
				>
					{remove.isPending ? 'Deleting…' : confirming ? 'Click again to delete' : thread ? 'Delete thread' : 'Delete task'}
				</MenuItem>
				{confirming && thread ? <div className="max-w-[240px] px-2 pb-1 text-[11px] leading-[15px] text-(--text-tertiary)">Its files stay in the project Library, in a folder named for it.</div> : null}
				{remove.isError ? <div className="max-w-[240px] px-2 pb-1 text-[11px] leading-[15px] text-(--danger-text)">{remove.error.message}</div> : null}
				<MenuSeparator />
				<TaskFacts session={session} />
			</MenuContent>
		</Menu>
	);
}
