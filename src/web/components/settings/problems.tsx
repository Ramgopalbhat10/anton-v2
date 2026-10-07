import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { Card, CardFooter, CardSection, SplitBar, Status } from '@/components/instrument';
import { Btn, Spinner } from '@/components/signal';
import { api, SAFETY_NET_MS } from '@/lib/api';
import { age } from '@/lib/format';
import { PageHeading } from './parts';

const PROBLEMS_SHOWN = 50;

function Problems() {
	const logs = useQuery({ queryKey: ['logs'], queryFn: api.logs, refetchInterval: SAFETY_NET_MS });
	if (logs.isPending) return <Spinner size={12} />;
	if (logs.isError) return <p className="m-0 text-[12px] text-(--danger-text)">{logs.error.message}</p>;
	const shown = logs.data.logs.slice(0, PROBLEMS_SHOWN);
	const errors = shown.filter((entry) => entry.level === 'error').length;
	return (
		<Card
			icon={TriangleAlert}
			title="Since Anton started"
			sub={`newest first · up to ${PROBLEMS_SHOWN}`}
			status={errors ? <Status tone="danger">{errors} errors</Status> : shown.length ? <Status tone="warning">{shown.length} warnings</Status> : <Status tone="success">Clear</Status>}
			footer={
				<CardFooter caption="The server log has everything">
					<Btn size="sm" icon={RotateCw} disabled={logs.isFetching} onClick={() => void logs.refetch()}>
						Refresh
					</Btn>
				</CardFooter>
			}
		>
			{shown.length ? (
				<CardSection ruled={false} className="pt-1">
					<SplitBar
						label="Problems by level"
						parts={[
							{ key: 'error', label: 'Errors', value: errors, color: 'var(--danger-base)' },
							{ key: 'warn', label: 'Warnings', value: shown.length - errors, color: 'var(--warning-base)' },
						]}
					/>
				</CardSection>
			) : null}
			<CardSection ruled={shown.length > 0} className="gap-0 py-1">
				{shown.length === 0 ? <p className="m-0 py-2 text-[12px] text-(--text-tertiary)">Nothing has gone wrong since Anton started.</p> : null}
				{shown.map((entry, index) => (
					<div key={`${entry.at}-${index}`} className="relative flex items-start gap-3 py-2.5 pl-1">
						{/* A rail through the dots, so the list reads as a timeline. */}
						{index < shown.length - 1 ? <span className="absolute top-[22px] bottom-[-10px] left-[7px] w-px bg-(--border-subtle)" /> : null}
						<span
							className="relative mt-[5px] size-[7px] shrink-0 rounded-full ring-4 ring-(--card-bg)"
							style={{ background: entry.level === 'error' ? 'var(--danger-base)' : 'var(--warning-base)' }}
						/>
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<div className="flex items-baseline gap-2">
								<span className="min-w-0 flex-1 text-[12px] font-medium text-(--text-primary)">{entry.message}</span>
								<span className="in-num shrink-0 text-[11px] text-(--text-disabled)">{age(entry.at)}</span>
							</div>
							{entry.detail ? <div className="font-mono text-[11px] leading-[16px] break-words text-(--text-tertiary)">{entry.detail}</div> : null}
							{entry.sessionId ? (
								<Link
									to="/agents/$sessionId"
									params={{ sessionId: entry.sessionId }}
									search={{ app: 'code' }}
									className="w-fit text-[11px] text-(--accent-text) underline-offset-2 hover:underline"
								>
									Open the task
								</Link>
							) : null}
						</div>
					</div>
				))}
			</CardSection>
		</Card>
	);
}

export function ProblemsPage() {
	return (
		<>
			<PageHeading title="Recent problems">
				Warnings and errors from work that runs on its own: sandbox setup, checkpoints, automations, pull request follow-ups and failed replies. Kept
				until Anton restarts; the server log has everything.
			</PageHeading>
			<Problems />
		</>
	);
}
