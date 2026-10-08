import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Box, Square } from 'lucide-react';
import { useState } from 'react';
import { SandboxArt } from '@/components/illustrations';
import { Card, CardFooter, CardSection, Facts, Figure, Status, Well } from '@/components/instrument';
import { Btn, IconBtn, Spinner } from '@/components/signal';
import { api, type ComputeView } from '@/lib/api';
import { age } from '@/lib/format';
import { PageHeading } from './parts';

function Running({ view }: { view: ComputeView }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ['compute'] });
		void queryClient.invalidateQueries({ queryKey: ['sessions'] });
	};
	const stop = useMutation({ mutationFn: (id: string) => api.stopSession(id), onSuccess: refresh });
	const stopAll = useMutation({ mutationFn: api.stopAllSandboxes, onSuccess: refresh, onSettled: () => setConfirming(false) });
	const count = view.running.length;
	return (
		<Card
			icon={Box}
			title="Running now"
			sub={view.provider === 'modal' ? `Modal · ${view.app}` : 'this server · local sandboxes'}
			status={count ? <Status tone="success" pulse>Live</Status> : <Status>Idle</Status>}
			footer={
				<CardFooter
					caption={
						stopAll.isError ? (
							<span className="text-[12px] text-(--danger-text)">{stopAll.error.message}</span>
						) : view.others > 0 ? (
							<span className="block text-[12px] leading-[18px] text-pretty text-(--text-disabled)">
								{view.others} more running in this app are not tasks of this Anton, so they are not shown or stopped here.
							</span>
						) : (
							'Stopping saves a checkpoint first'
						)
					}
				>
					{count ? (
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
					) : null}
				</CardFooter>
			}
		>
			<CardSection ruled={false} className="pt-1">
				<Figure value={String(count)} unit={count === 1 ? 'sandbox running' : 'sandboxes running'} />
			</CardSection>
			{count === 0 ? (
				<CardSection>
					<Well grid className="flex flex-col items-center gap-3 px-6 pt-5 pb-6 text-center">
						<SandboxArt className="w-full max-w-[280px]" />
						<div className="flex flex-col gap-1">
							<div className="text-[14px] font-medium">Nothing is running</div>
							<div className="max-w-[44ch] text-[12px] leading-[18px] text-(--text-tertiary)">A sandbox starts when a task needs to edit or run code.</div>
						</div>
					</Well>
				</CardSection>
			) : (
				<CardSection className="gap-0 px-2 py-1.5">
					{view.running.map((task) => (
						<div key={task.id} className="flex min-h-12 items-center gap-3 rounded-[10px] px-2 py-1.5 hover:bg-(--bg-hover)">
							<span className="in-pulse size-1.5 shrink-0 rounded-full bg-(--success-base)" />
							<Link
								to="/agents/$sessionId"
								params={{ sessionId: task.id }}
								search={{ app: 'code' }}
								className="flex min-w-0 flex-1 flex-col gap-0.5 outline-none focus-visible:shadow-(--focus-ring)"
							>
								<span className="truncate text-[13px] font-medium">{task.title}</span>
								<Facts items={[task.repo, `created ${age(task.createdAt)} ago`]} className="tracking-[0.04em] normal-case" />
							</Link>
							<IconBtn icon={Square} size="sm" label={`Stop ${task.title}`} disabled={stop.isPending} onClick={() => stop.mutate(task.id)} />
						</div>
					))}
				</CardSection>
			)}
		</Card>
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
				<Running view={view} />
			) : null}
		</>
	);
}
