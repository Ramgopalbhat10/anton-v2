import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft, History, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DiffList } from '@/components/git-tab';
import { useRefreshTask } from '@/components/source-bar';
import { HistoryArt } from '@/components/illustrations';
import { DiffBars, Status } from '@/components/instrument';
import { Btn, DiffStat, EmptyState, Icon, Spinner } from '@/components/signal';
import { api, type CheckpointSummary, SAFETY_NET_MS } from '@/lib/api';
import { parsePatch } from '@/lib/diff';
import { age, clock } from '@/lib/format';
import { cn } from '@/lib/utils';

function Loading({ label }: { label: string }) {
	return (
		<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
			<Spinner size={12} />
			{label}
		</div>
	);
}

/** Restores asks twice, since it replaces the task's current files. */
function RestoreButton({ sessionId, at, onDone }: { sessionId: string; at: string; onDone: (skipped: string[]) => void }) {
	const [confirming, setConfirming] = useState(false);
	const refresh = useRefreshTask(sessionId);
	const restore = useMutation({
		mutationFn: () => api.restoreCheckpoint(sessionId, at),
		onSuccess: (result) => onDone(result.skipped),
		onSettled: () => {
			setConfirming(false);
			refresh();
		},
	});
	return (
		<div className="flex min-w-0 items-center gap-2">
			{restore.isError ? <span className="min-w-0 truncate text-[12px] text-(--danger-text)">{restore.error.message}</span> : null}
			<Btn
				size="xs"
				variant={confirming ? 'danger' : 'secondary'}
				icon={RotateCcw}
				disabled={restore.isPending}
				onClick={() => (confirming ? restore.mutate() : setConfirming(true))}
				onBlur={() => setConfirming(false)}
			>
				{restore.isPending ? 'Restoring…' : confirming ? 'Replace the current files' : 'Restore'}
			</Btn>
		</div>
	);
}

function CheckpointView({ sessionId, entry, latest, onBack }: { sessionId: string; entry: CheckpointSummary; latest: boolean; onBack: () => void }) {
	const [restored, setRestored] = useState<string[] | null>(null);
	const detail = useQuery({ queryKey: ['checkpoint', sessionId, entry.at], queryFn: () => api.checkpoint(sessionId, entry.at), staleTime: Infinity });
	const files = useMemo(() => parsePatch(detail.data?.patch ?? ''), [detail.data]);
	return (
		<div className="flex flex-col gap-2">
			<div className="flex h-7 items-center gap-2">
				<Btn variant="ghost" size="xs" icon={ChevronLeft} onClick={onBack}>
					History
				</Btn>
				<span className="in-caption min-w-0 flex-1 truncate">Saved at {clock(entry.at)}</span>
				{latest ? (
					<Status tone="accent">Current files</Status>
				) : (
					<RestoreButton sessionId={sessionId} at={entry.at} onDone={setRestored} />
				)}
			</div>
			{restored ? (
				<div className="flex items-start gap-2.5 rounded-[10px] border border-(--border-subtle) bg-(--success-bg) px-3 py-2.5 text-[12px] leading-[18px] text-(--text-secondary)">
					<Icon icon={Check} size={13} className="mt-0.5 text-(--success-text)" />
					<span>
					Files restored. Commits and the conversation are unchanged, so tell the agent if it should know.
					{restored.length > 0 ? ` Too large to have been saved, so left as they were: ${restored.join(', ')}.` : ''}
					</span>
				</div>
			) : null}
			{detail.isPending ? (
				<Loading label="Loading the diff" />
			) : detail.isError ? (
				<EmptyState title="Checkpoint unavailable" body={detail.error.message} />
			) : detail.data.patch === null ? (
				<EmptyState icon={History} title="No diff saved" body="This checkpoint was saved before diffs were kept. It can still be restored." />
			) : (
				<DiffList files={files} empty="The files matched the starting commit at this point." />
			)}
		</div>
	);
}

/** Every distinct state of the task's files, one per agent response that changed something. */
export function HistoryTab({ sessionId }: { sessionId: string }) {
	const [selected, setSelected] = useState<string | null>(null);
	const timeline = useQuery({ queryKey: ['checkpoints', sessionId], queryFn: () => api.checkpoints(sessionId), refetchInterval: SAFETY_NET_MS });
	const entries = timeline.data?.checkpoints ?? [];
	const current = entries.find((entry) => entry.at === selected);

	if (current) {
		return <CheckpointView sessionId={sessionId} entry={current} latest={current === entries[0]} onBack={() => setSelected(null)} />;
	}
	if (timeline.isPending) return <Loading label="Loading the history" />;
	if (timeline.isError) return <EmptyState title="History unavailable" body={timeline.error.message} />;
	if (entries.length === 0) {
		return <EmptyState art={<HistoryArt className="w-full max-w-[340px]" />} title="No checkpoints yet" body="Each time the agent finishes a reply that changed files, the state is saved here." />;
	}
	return (
		<div className="flex flex-col gap-2.5">
			<div className="in-caption flex h-7 items-center gap-2">
				<span>
					{entries.length} {entries.length === 1 ? 'checkpoint' : 'checkpoints'}
				</span>
				<span className="flex-1" />
				<span className="normal-case tracking-normal">One per reply that changed files</span>
			</div>
			<ol className="in-card m-0 list-none p-1.5" aria-label="Checkpoints">
				{entries.map((entry, index) => (
					<li key={entry.at} className="relative">
						{/* The timeline runs through every checkpoint's node, newest at the top. */}
						<span aria-hidden className={cn('absolute left-[17px] w-px bg-(--border-default)', index === 0 ? 'top-1/2' : 'top-0', index === entries.length - 1 ? 'bottom-1/2' : 'bottom-0')} />
						<button
							type="button"
							onClick={() => setSelected(entry.at)}
							className="relative flex min-h-14 w-full items-center gap-3 rounded-lg py-2 pr-2.5 pl-3 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
						>
							<span
								className={cn(
									'relative size-[11px] shrink-0 rounded-full border-2',
									index === 0 ? 'border-(--accent-base) bg-(--accent-bg-subtle) shadow-[0_0_0_3px_var(--accent-bg-subtle)]' : 'border-(--text-disabled) bg-(--card-bg)',
								)}
							/>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<div className="flex min-w-0 items-center gap-2 text-[12.5px] text-(--text-primary)">
									<span className="truncate">
										{entry.files} {entry.files === 1 ? 'file' : 'files'} changed
									</span>
									{index === 0 ? <Status tone="accent">Current</Status> : null}
								</div>
								<div className="truncate text-[11.5px] text-(--text-tertiary)">{entry.commit ?? 'No commits yet'}</div>
							</div>
							{entry.added !== null && entry.removed !== null ? (
								<span className="hidden shrink-0 items-center gap-2 sm:flex">
									<span className="in-num">
										<DiffStat added={entry.added} removed={entry.removed} />
									</span>
									<DiffBars added={entry.added} removed={entry.removed} />
								</span>
							) : null}
							<span className="flex w-12 shrink-0 flex-col items-end">
								<span className="in-num text-[11.5px] text-(--text-secondary)">{clock(entry.at)}</span>
								<span className="in-num text-[10.5px] text-(--text-disabled)">{age(entry.at)}</span>
							</span>
						</button>
					</li>
				))}
			</ol>
		</div>
	);
}
