import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { type ReactNode, useCallback } from 'react';
import { Btn } from '@/components/signal';
import { api, type Source } from '@/lib/api';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';

const LABEL: Record<Source, (at: string | null) => string> = {
	live: () => 'Live',
	saved: (at) => (at ? `Saved ${age(at)}` : 'Saved'),
	base: () => 'Starting point',
};

/** Refetches every view of a task, for when its sandbox starts or stops. */
export function useRefreshTask(sessionId: string) {
	const queryClient = useQueryClient();
	return useCallback(
		() =>
			void queryClient.invalidateQueries({
				predicate: (query) => query.queryKey[0] === 'sessions' || query.queryKey.includes(sessionId),
			}),
		[queryClient, sessionId],
	);
}

/** Starts the task's sandbox, then refreshes every view of the task. */
export function useResume(sessionId: string) {
	return useMutation({ mutationFn: () => api.resumeSession(sessionId), onSettled: useRefreshTask(sessionId) });
}

/**
 * Heading row for a workspace panel: what it shows, and where the data came
 * from. When the sandbox is not running, it offers to start it.
 */
export function SourceBar({
	sessionId,
	source,
	at,
	children,
}: {
	sessionId: string;
	source: Source | undefined;
	at: string | null | undefined;
	children: ReactNode;
}) {
	const resume = useResume(sessionId);
	return (
		<div className="flex h-7 min-w-0 shrink-0 items-center gap-2.5 text-[11px] tracking-[0.04em] whitespace-nowrap">
			{children}
			<div className="flex-1" />
			{source ? (
				<span className={cn('flex items-center gap-1.5', source === 'live' ? 'text-(--success-text)' : 'text-(--text-tertiary)')}>
					<span className={cn('size-1.5 rounded-full', source === 'live' ? 'bg-(--success-base)' : 'bg-(--text-disabled)')} />
					{LABEL[source](at ?? null)}
				</span>
			) : null}
			{source && source !== 'live' ? (
				<Btn variant="ghost" size="xs" icon={Play} disabled={resume.isPending} onClick={() => resume.mutate()}>
					{resume.isPending ? 'Starting…' : 'Resume'}
				</Btn>
			) : null}
		</div>
	);
}
