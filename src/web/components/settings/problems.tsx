import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlert, RotateCw, TriangleAlert } from 'lucide-react';
import { Btn, Icon, Spinner } from '@/components/signal';
import { api, SAFETY_NET_MS } from '@/lib/api';
import { age } from '@/lib/format';
import { PageHeading } from './parts';

const PROBLEMS_SHOWN = 50;

function Problems() {
	const logs = useQuery({ queryKey: ['logs'], queryFn: api.logs, refetchInterval: SAFETY_NET_MS });
	if (logs.isPending) return <Spinner size={12} />;
	if (logs.isError) return <p className="m-0 text-[12px] text-(--danger-text)">{logs.error.message}</p>;
	const shown = logs.data.logs.slice(0, PROBLEMS_SHOWN);
	return (
		<div className="flex flex-col gap-1.5">
			{shown.length === 0 ? <p className="m-0 text-[12px] text-(--text-tertiary)">Nothing has gone wrong since Anton started.</p> : null}
			{shown.map((entry, index) => (
				<div key={`${entry.at}-${index}`} className="flex items-start gap-2 rounded-lg bg-(--bg-surface) px-3 py-2">
					<Icon
						icon={entry.level === 'error' ? CircleAlert : TriangleAlert}
						size={12}
						className={entry.level === 'error' ? 'mt-[3px] text-(--danger-text)' : 'mt-[3px] text-(--warning-text)'}
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<div className="text-[12px] text-(--text-primary)">{entry.message}</div>
						{entry.detail ? <div className="text-[12px] break-words text-(--text-tertiary)">{entry.detail}</div> : null}
						<div className="text-[11px] text-(--text-disabled)">
							{age(entry.at)}
							{entry.sessionId ? (
								<>
									{' · '}
									<Link to="/agents/$sessionId" params={{ sessionId: entry.sessionId }} search={{ app: 'code' }} className="underline underline-offset-2">
										Open the task
									</Link>
								</>
							) : null}
						</div>
					</div>
				</div>
			))}
			<Btn size="sm" variant="ghost" icon={RotateCw} className="self-start" disabled={logs.isFetching} onClick={() => void logs.refetch()}>
				Refresh
			</Btn>
		</div>
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
