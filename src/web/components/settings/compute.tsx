import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Box, Square } from 'lucide-react';
import { useState } from 'react';
import { Btn, EmptyState, Icon, IconBtn, Spinner } from '@/components/signal';
import { api, type ComputeView } from '@/lib/api';
import { age } from '@/lib/format';
import { Block, List, PageHeading } from './parts';

function Running({ view }: { view: ComputeView }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ['compute'] });
		void queryClient.invalidateQueries({ queryKey: ['sessions'] });
	};
	const stop = useMutation({ mutationFn: (id: string) => api.stopSession(id), onSuccess: refresh });
	const stopAll = useMutation({ mutationFn: api.stopAllSandboxes, onSuccess: refresh, onSettled: () => setConfirming(false) });
	if (view.running.length === 0) return <EmptyState icon={Box} title="Nothing is running" body="A sandbox starts when a task needs to edit or run code." />;
	return (
		<div className="flex flex-col gap-2">
			<List>
				{view.running.map((task) => (
					<div key={task.id} className="flex min-h-12 items-center gap-3 rounded-lg px-2.5 py-1.5">
						<Link
							to="/agents/$sessionId"
							params={{ sessionId: task.id }}
							search={{ app: 'code' }}
							className="flex min-w-0 flex-1 flex-col gap-0.5 outline-none hover:underline focus-visible:shadow-(--focus-ring)"
						>
							<span className="truncate text-[13px] font-medium">{task.title}</span>
							<span className="truncate text-[12px] text-(--text-tertiary)">
								{task.repo} · task created {age(task.createdAt)} ago
							</span>
						</Link>
						<IconBtn icon={Square} size="sm" label={`Stop ${task.title}`} disabled={stop.isPending} onClick={() => stop.mutate(task.id)} />
					</div>
				))}
			</List>
			<div className="flex items-center gap-3">
				<Btn
					size="sm"
					variant="dangerGhost"
					icon={Square}
					disabled={stopAll.isPending}
					onClick={() => (confirming ? stopAll.mutate() : setConfirming(true))}
					onBlur={() => setConfirming(false)}
				>
					{stopAll.isPending ? 'Stopping…' : confirming ? 'Click again to stop all' : 'Stop every sandbox'}
				</Btn>
				{stopAll.isError ? <span className="text-[12px] text-(--danger-text)">{stopAll.error.message}</span> : null}
			</div>
		</div>
	);
}

/** Where sandboxes run and which are up right now. */
export function ComputePage() {
	const compute = useQuery({ queryKey: ['compute'], queryFn: api.compute });
	const view = compute.data;
	return (
		<>
			<PageHeading title="Compute">
				Every task that edits or runs code gets its own sandbox. Stopping one saves a checkpoint first, and the task picks up where it left off the
				next time it needs a machine.
			</PageHeading>
			{compute.isPending ? (
				<Spinner size={12} />
			) : compute.isError ? (
				<p className="m-0 text-[12px] text-(--danger-text)">{compute.error.message}</p>
			) : view ? (
				<>
					<div className="flex items-center gap-2 text-[13px] text-(--text-secondary)">
						<Icon icon={Box} className="text-(--icon-tertiary)" />
						{view.provider === 'modal' ? `Modal, app ${view.app}` : 'This server (local sandboxes)'}
					</div>
					<Block
						title="Running now"
						help={view.others > 0 ? `${view.others} more running in this app are not tasks of this Anton, so they are not shown or stopped here.` : undefined}
					>
						<Running view={view} />
					</Block>
				</>
			) : null}
		</>
	);
}
