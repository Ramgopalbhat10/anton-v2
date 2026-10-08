import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Trash2 } from 'lucide-react';
import { StorageArt } from '@/components/illustrations';
import { Card, CardFooter, CardSection, Figure, StatRow, Status, Well } from '@/components/instrument';
import { Btn, Spinner } from '@/components/signal';
import { api } from '@/lib/api';
import { age } from '@/lib/format';
import { PageHeading, size } from './parts';

function Usage() {
	const queryClient = useQueryClient();
	const storage = useQuery({ queryKey: ['storage'], queryFn: api.storage });
	const clean = useMutation({ mutationFn: api.cleanUpStorage, onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['storage'] }) });
	if (storage.isPending) return <Spinner size={12} />;
	if (storage.isError) return <p className="m-0 text-[12px] text-(--danger-text)">{storage.error.message}</p>;
	const { objects, bytes, lastCleanup } = storage.data;
	const last = clean.data ?? lastCleanup;
	return (
		<Card
			icon={HardDrive}
			title="Object storage"
			sub="checkpoints · diffs · Library"
			status={<Status>{objects.toLocaleString()} objects</Status>}
			footer={
				<CardFooter
					caption={
						clean.isError ? (
							<span className="text-[12px] text-(--danger-text)">{clean.error.message}</span>
						) : (
							'Cleanup runs once a day'
						)
					}
				>
					<Btn size="sm" icon={Trash2} disabled={clean.isPending} onClick={() => clean.mutate()}>
						{clean.isPending ? 'Cleaning up…' : 'Clean up now'}
					</Btn>
				</CardFooter>
			}
		>
			<CardSection ruled={false} className="pt-1">
				<div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1">
							<span className="in-caption">In use</span>
							<Figure size="xl" value={size(bytes)} />
						</div>
						<p className="m-0 max-w-[52ch] text-[12px] leading-[18px] text-pretty text-(--text-tertiary)">
							Cleanup removes deleted tasks, history beyond the newest 50 entries per task, and file contents nothing uses any more.
						</p>
					</div>
					<Well grid className="flex items-center justify-center py-3">
						<StorageArt className="w-[170px]" />
					</Well>
				</div>
			</CardSection>
			<StatRow
				stats={[
					{ label: 'objects', value: objects.toLocaleString() },
					{ label: clean.data ? 'just removed' : 'removed last run', value: last ? last.removed.toLocaleString() : '—' },
					{ label: last ? `freed ${age(last.at)} ago` : 'not run yet', value: last ? size(last.freedBytes) : '—' },
				]}
			/>
		</Card>
	);
}

export function StoragePage() {
	return (
		<>
			<PageHeading title="Storage">Checkpoints, diffs and Library files are kept in object storage, so a stopped task's work is there without its sandbox.</PageHeading>
			<Usage />
		</>
	);
}
