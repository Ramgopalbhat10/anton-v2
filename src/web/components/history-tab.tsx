import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft, History, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DiffList } from '@/components/git-tab';
import { useRefreshTask } from '@/components/source-bar';
import { HistoryArt } from '@/components/illustrations';
import { Btn, DiffStat, EmptyState, Spinner } from '@/components/signal';
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
				<span className="min-w-0 flex-1 truncate text-[12px] text-(--text-tertiary)">
					Saved at {clock(entry.at)}
				</span>
				{latest ? (
					<span className="text-[11px] text-(--text-disabled)">Current files</span>
				) : (
					<RestoreButton sessionId={sessionId} at={entry.at} onDone={setRestored} />
				)}
			</div>
			{restored ? (
				<div className="rounded-lg bg-(--bg-raised) px-3 py-2 text-[12px] leading-[18px] text-(--text-secondary)">
					Files restored. Commits and the conversation are unchanged, so tell the agent if it should know.
					{restored.length > 0 ? ` Too large to have been saved, so left as they were: ${restored.join(', ')}.` : ''}
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
		return <EmptyState art={<HistoryArt className="w-[190px]" />} title="No checkpoints yet" body="Each time the agent finishes a reply that changed files, the state is saved here." className="pt-10" />;
	}
	return (
		<div className="flex flex-col gap-px pt-1">
			{entries.map((entry, index) => (
				<button
					type="button"
					key={entry.at}
					onClick={() => setSelected(entry.at)}
					className="flex h-11 items-center gap-2.5 rounded-md px-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
				>
					<span className={cn('size-1.5 shrink-0 rounded-full', index === 0 ? 'bg-(--accent-base)' : 'bg-(--text-disabled)')} />
					<div className="flex min-w-0 flex-1 flex-col gap-px">
						<div className="flex items-center gap-2 truncate text-[12px] text-(--text-primary)">
							{entry.files} {entry.files === 1 ? 'file' : 'files'} changed
							{entry.added !== null && entry.removed !== null ? <DiffStat added={entry.added} removed={entry.removed} /> : null}
							{index === 0 ? <span className="text-(--text-tertiary)">Current</span> : null}
						</div>
						<div className="truncate text-[11px] text-(--text-disabled)">{entry.commit ?? 'No commits yet'}</div>
					</div>
					<span className="shrink-0 text-[11px] text-(--text-tertiary)">
						{clock(entry.at)} · {age(entry.at)}
					</span>
				</button>
			))}
		</div>
	);
}
