import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Play, X } from 'lucide-react';
import { memo, useContext } from 'react';
import { ReplyActions, type ReplyPlace } from '@/components/reply-cards';
import { Btn, Icon, Spinner } from '@/components/signal';
import { api, type ToolApproval } from '@/lib/api';
import { composioEntryFor } from '@/lib/connector-catalog';
import { cn } from '@/lib/utils';
import { taskQueries } from '@/lib/task-queries';

/** The approval a connector tool call made, named at the end of its result. */
export function toolApprovalOf(output: unknown): string | null {
	const text = typeof output === 'string' ? output : output && typeof output === 'object' && typeof (output as { output?: unknown }).output === 'string' ? (output as { output: string }).output : '';
	return /\[approval:(tool_[\w-]+)\]/.exec(text)?.[1] ?? null;
}

const time = (at: string | null) => (at ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

/** `composio:slack` reads as the app's name; any other connector as it is. */
const connectorName = (connector: string) => {
	const toolkit = /^composio:(.+)$/.exec(connector)?.[1];
	return toolkit ? (composioEntryFor(toolkit)?.name ?? toolkit) : connector;
};

/** Arguments as the agent gave them, one per line, values kept readable. */
function argsText(args: Record<string, unknown>): string {
	return Object.entries(args)
		.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
		.join('\n');
}

/**
 * A connector tool call the agent asked to run — a post, a create, a delete —
 * with Run and Don't run. Run goes through Anton's server, never the agent,
 * and the agent hears of it as your next message. What happened is kept on
 * the server, so a reload shows it.
 */
export const ToolApprovalCard = memo(function ToolApprovalCard({ sessionId, approvalId, place }: { sessionId: string; approvalId: string; place: ReplyPlace }) {
	const { send: reply, busy } = useContext(ReplyActions);
	const queryClient = useQueryClient();
	const approvals = useQuery(taskQueries.toolApprovals(sessionId));
	const approval = approvals.data?.approvals.find((item) => item.id === approvalId);
	const decide = useMutation({
		mutationFn: (run: boolean) => api.decideToolApproval(sessionId, approvalId, run),
		onSuccess: (next, run) => {
			queryClient.setQueryData<{ approvals: ToolApproval[] }>(['tool-approvals', sessionId], (current) =>
				current ? { approvals: current.approvals.map((item) => (item.id === next.id ? next : item)) } : current,
			);
			// The agent waits for an answer; one already working hears of it when it next reads the thread.
			if (place.latest && !busy) reply(run ? `I ran ${next.tool}.` : `Don't run ${next.tool}.`);
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['tool-approvals', sessionId] }),
	});
	if (!approval) {
		return approvals.isPending ? (
			<div className="flex h-9 items-center gap-2 rounded-control border border-dashed border-(--line) px-3 text-small text-(--text-3)">
				<Spinner size={12} />
				Preparing the call
			</div>
		) : null;
	}
	const pending = approval.state === 'pending' || approval.state === 'running';
	const status =
		approval.state === 'done' ? (
			<span className="inline-flex items-center gap-1.5 text-(--ok)">
				<Icon icon={Check} size={12} />
				Ran {time(approval.decidedAt)}
			</span>
		) : approval.state === 'declined' ? (
			<span className="inline-flex items-center gap-1.5 text-(--text-3)">
				<Icon icon={X} size={12} />
				Not run
			</span>
		) : approval.state === 'failed' ? (
			<span className="text-(--bad)">It failed{approval.error ? `: ${approval.error}` : ''}</span>
		) : null;
	return (
		<section className={cn('in-callout overflow-hidden', pending && 'in-callout--warn')} aria-label="Tool call to run">
			<header className="flex items-start gap-2.5 px-3.5 pt-3 pb-2">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h3 className="m-0 truncate text-body leading-[20px] font-medium text-(--text)">{approval.tool}</h3>
					<span className="text-small text-(--text-3)">{pending ? `The agent asks to run this on ${connectorName(approval.connector)}` : `Tool call on ${connectorName(approval.connector)}`}</span>
				</div>
			</header>
			<div
				className={cn(
					'mx-3.5 mb-3 overflow-auto rounded-control bg-(--bg-panel) px-3 py-2 font-mono text-small leading-[19px] whitespace-pre-wrap text-(--text-2) shadow-[inset_0_0_0_1px_var(--line)]',
					pending ? 'max-h-[200px]' : 'max-h-[240px]',
				)}
			>
				{approval.state === 'done' && approval.result !== null ? approval.result : argsText(approval.args) || '(no arguments)'}
			</div>
			<footer className="flex min-h-11 flex-wrap items-center justify-end gap-2 border-t border-(--line) px-3.5 py-2 text-small">
				{decide.error ? <span className="mr-auto text-(--bad)">{decide.error.message}</span> : null}
				{status ? <span className="mr-auto">{status}</span> : null}
				{pending ? (
					<>
						<Btn size="sm" variant="ghost" disabled={decide.isPending || approval.state === 'running'} onClick={() => decide.mutate(false)}>
							Don't run
						</Btn>
						<Btn size="sm" variant="primary" icon={Play} disabled={decide.isPending || approval.state === 'running'} onClick={() => decide.mutate(true)}>
							{decide.isPending || approval.state === 'running' ? 'Running…' : 'Run'}
						</Btn>
					</>
				) : null}
			</footer>
		</section>
	);
});
