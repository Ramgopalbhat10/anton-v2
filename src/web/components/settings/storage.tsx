import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Trash2 } from 'lucide-react';
import { Btn, Icon, Spinner } from '@/components/signal';
import { api } from '@/lib/api';
import { age } from '@/lib/format';
import { Block, PageHeading, size } from './parts';

function Usage() {
	const queryClient = useQueryClient();
	const storage = useQuery({ queryKey: ['storage'], queryFn: api.storage });
	const clean = useMutation({ mutationFn: api.cleanUpStorage, onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['storage'] }) });
	if (storage.isPending) return <Spinner size={12} />;
	if (storage.isError) return <p className="m-0 text-[12px] text-(--danger-text)">{storage.error.message}</p>;
	const { objects, bytes, lastCleanup } = storage.data;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2 text-[13px] text-(--text-secondary)">
				<Icon icon={HardDrive} className="text-(--icon-tertiary)" />
				{size(bytes)} in {objects.toLocaleString()} objects
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<Btn size="sm" icon={Trash2} disabled={clean.isPending} onClick={() => clean.mutate()}>
					{clean.isPending ? 'Cleaning up…' : 'Clean up now'}
				</Btn>
				<span className="text-[12px] text-(--text-tertiary)">
					{clean.data
						? `Removed ${clean.data.removed} objects, ${size(clean.data.freedBytes)}.`
						: lastCleanup
							? `Last run ${age(lastCleanup.at)} ago: removed ${lastCleanup.removed} objects, ${size(lastCleanup.freedBytes)}.`
							: 'Not run yet.'}
				</span>
				{clean.isError ? <span className="text-[12px] text-(--danger-text)">{clean.error.message}</span> : null}
			</div>
		</div>
	);
}

export function StoragePage() {
	return (
		<>
			<PageHeading title="Storage">Checkpoints, diffs and Library files are kept in object storage, so a stopped task's work is there without its sandbox.</PageHeading>
			<Block
				title="Object storage"
				help="Cleanup runs once a day and removes deleted tasks, history beyond the newest 50 entries per task, and file contents nothing uses any more."
			>
				<Usage />
			</Block>
		</>
	);
}
