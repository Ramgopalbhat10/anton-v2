import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, GitPullRequest, MoreHorizontal, Pencil, Settings, Square, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Icon, IconBtn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/signal';
import { isLive } from '@/components/task-status';
import { api, type PullRequest, type Session } from '@/lib/api';
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

/** Click to rename; Enter or leaving the field saves, Escape cancels. */
export function TaskTitle({ session, editing, onEditingChange }: { session?: Session; editing: boolean; onEditingChange: (next: boolean) => void }) {
	const queryClient = useQueryClient();
	const rename = useMutation({
		mutationFn: (title: string) => api.editSession(session!.id, { title }),
		onSuccess: (updated) => {
			queryClient.setQueryData(['session', updated.id], updated);
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
	});
	const title = session?.title ?? 'Task';
	if (!editing || !session) {
		return (
			<button
				type="button"
				onClick={() => session && onEditingChange(true)}
				title="Rename task"
				className="min-w-[100px] flex-auto truncate text-left text-[13px] font-medium outline-none"
			>
				{rename.isPending ? rename.variables : title}
			</button>
		);
	}
	const save = (value: string) => {
		onEditingChange(false);
		if (value.trim() && value.trim() !== title) rename.mutate(value.trim());
	};
	return (
		<input
			autoFocus
			defaultValue={title}
			maxLength={200}
			aria-label="Task title"
			onFocus={(event) => event.currentTarget.select()}
			onBlur={(event) => save(event.currentTarget.value)}
			onKeyDown={(event) => {
				if (event.key === 'Enter') save(event.currentTarget.value);
				if (event.key === 'Escape') onEditingChange(false);
			}}
			className="h-7 min-w-[100px] flex-auto rounded-md bg-(--bg-raised) px-2 text-[13px] font-medium text-(--text-primary) outline-none focus-visible:shadow-(--focus-ring)"
		/>
	);
}

/**
 * Rename, ask for a pull request, open the repo's settings, stop the sandbox, or delete the task.
 * Delete asks twice inside the menu, so a stray click never loses a task.
 */
export function TaskMenu({ session, onRename, onAskForPullRequest }: { session: Session; onRename: () => void; onAskForPullRequest: () => void }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [confirming, setConfirming] = useState(false);
	const refresh = () => void queryClient.invalidateQueries({ queryKey: ['sessions'] });
	const stop = useMutation({ mutationFn: () => api.stopSession(session.id), onSuccess: refresh });
	const remove = useMutation({
		mutationFn: async () => {
			if (session.working) await api.stopAgent(session.id).catch(() => undefined);
			await api.deleteSession(session.id);
		},
		onSuccess: () => {
			refresh();
			void navigate({ to: '/' });
		},
	});

	return (
		<Menu onOpenChange={(open) => !open && setConfirming(false)}>
			<MenuTrigger asChild>
				<IconBtn icon={MoreHorizontal} size="sm" label="Task actions" />
			</MenuTrigger>
			<MenuContent align="end">
				<MenuItem icon={Pencil} onSelect={onRename}>
					Rename
				</MenuItem>
				<MenuItem icon={GitPullRequest} onSelect={onAskForPullRequest}>
					{session.prUrl ? 'Update the pull request' : 'Open a pull request'}
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
			</MenuContent>
		</Menu>
	);
}
