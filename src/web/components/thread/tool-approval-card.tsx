import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, CircleAlert, Play, X } from '@/lib/icons';
import { memo, useId, useState } from 'react';
import { MarkTile, useComposioMark } from '@/components/marks/brand-marks';
import { Disclosure } from '@/components/kit/disclosure';
import { Btn, Icon, Spinner } from '@/components/kit/signal';
import { api } from '@/lib/api';
import type { ToolApproval } from '@/lib/api/notify';
import { composioEntryFor } from '@/lib/connector-catalog';
import { cn } from '@/lib/utils';
import { taskQueries } from '@/lib/task-queries';

export function toolApprovalOf(output: unknown): string | null {
	const text = typeof output === 'string' ? output : output && typeof output === 'object' && typeof (output as { output?: unknown }).output === 'string' ? (output as { output: string }).output : '';
	return /\[approval:(tool_[\w-]+)\]/.exec(text)?.[1] ?? null;
}

const time = (at: string | null) => (at ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

const toolkitOf = (connector: string) => /^composio:(.+)$/.exec(connector)?.[1] ?? null;

/** `composio__databricks__submit_run` reads as `submit_run`; the full name stays in its title. */
export function shortToolName(tool: string, connector: string): string {
	const prefix = `composio__${toolkitOf(connector)}__`;
	return tool.startsWith(prefix) && tool.length > prefix.length ? tool.slice(prefix.length) : tool;
}

function argsText(args: Record<string, unknown>): string {
	return Object.entries(args)
		.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
		.join('\n');
}

const CODE = 'overflow-auto rounded-control bg-(--bg-panel) px-3 py-2 font-mono text-small leading-[19px] whitespace-pre-wrap break-words text-(--text-2) shadow-[inset_0_0_0_1px_var(--line)]';

function Section({ label, text, tone }: { label: string; text: string; tone?: 'bad' }) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span className="text-micro font-medium tracking-wide text-(--text-3) uppercase">{label}</span>
			<div className={cn(CODE, 'max-h-[240px]', tone === 'bad' && 'text-(--bad)')}>{text}</div>
		</div>
	);
}

/** Run goes through Anton's server, never the agent, and the server tells the agent the answer and the call's result. */
export const ToolApprovalCard = memo(function ToolApprovalCard({ sessionId, approvalId }: { sessionId: string; approvalId: string }) {
	const queryClient = useQueryClient();
	const approvals = useQuery(taskQueries.toolApprovals(sessionId));
	const approval = approvals.data?.approvals.find((item) => item.id === approvalId);
	const [open, setOpen] = useState(false);
	const detailsId = useId();
	const toolkit = approval ? toolkitOf(approval.connector) : null;
	const entry = toolkit ? composioEntryFor(toolkit) : undefined;
	const name = approval ? (toolkit ? (entry?.name ?? toolkit.charAt(0).toUpperCase() + toolkit.slice(1)) : approval.connector) : '';
	const mark = useComposioMark(null, entry?.url ?? '', name);
	const decide = useMutation({
		mutationFn: (run: boolean) => api.decideToolApproval(sessionId, approvalId, run),
		onSuccess: (next) => {
			queryClient.setQueryData<{ approvals: ToolApproval[] }>(['tool-approvals', sessionId], (current) =>
				current ? { approvals: current.approvals.map((item) => (item.id === next.id ? next : item)) } : current,
			);
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
	const action = shortToolName(approval.tool, approval.connector);
	const args = argsText(approval.args) || '(no arguments)';
	if (approval.state === 'pending' || approval.state === 'running') {
		const running = decide.isPending || approval.state === 'running';
		return (
			<section className="in-callout in-callout--warn overflow-hidden" aria-label="Tool call to run">
				<header className="flex items-center gap-2.5 px-3.5 pt-3 pb-2">
					<MarkTile mark={mark} size={22} className="rounded-control" />
					<div className="flex min-w-0 flex-1 flex-col">
						<h3 className="m-0 text-body leading-[20px] font-medium text-(--text)">Run this on {name}?</h3>
						<span className="truncate font-mono text-small text-(--text-3)" title={approval.tool}>
							{action}
						</span>
					</div>
				</header>
				<div className={cn(CODE, 'mx-3.5 mb-3 max-h-[160px]')}>{args}</div>
				<footer className="flex min-h-11 flex-wrap items-center justify-end gap-2 border-t border-(--line) px-3.5 py-2 text-small">
					{decide.error ? <span className="mr-auto text-(--bad)">{decide.error.message}</span> : <span className="mr-auto text-(--text-3)">Nothing runs until you press Run.</span>}
					<Btn size="sm" variant="ghost" disabled={running} onClick={() => decide.mutate(false)}>
						Don't run
					</Btn>
					<Btn size="sm" variant="primary" icon={Play} disabled={running} onClick={() => decide.mutate(true)}>
						{running ? 'Running…' : 'Run'}
					</Btn>
				</footer>
			</section>
		);
	}
	const verb = approval.state === 'done' ? 'Ran' : approval.state === 'declined' ? 'Did not run' : 'Failed to run';
	const status =
		approval.state === 'done' ? (
			<span className="inline-flex items-center gap-1 text-(--ok)">
				<Icon icon={Check} size={12} />
				{time(approval.decidedAt)}
			</span>
		) : approval.state === 'declined' ? (
			<span className="inline-flex items-center gap-1 text-(--text-3)">
				<Icon icon={X} size={12} />
				Not run
			</span>
		) : (
			<span className="inline-flex items-center gap-1 text-(--bad)">
				<Icon icon={CircleAlert} size={12} />
				Failed
			</span>
		);
	// Once answered it folds to one line where the call was made; what was sent and what came back open on demand.
	return (
		<section className="flex flex-col" aria-label="Tool call">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={detailsId}
				onClick={() => setOpen((current) => !current)}
				className="group/call -mx-2 flex h-7 w-[calc(100%+16px)] items-center gap-2 rounded-control px-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
			>
				<span className="inline-flex size-3.5 shrink-0 items-center justify-center">
					<Icon icon={ChevronDown} size={13} className="text-(--text-3) transition-transform duration-(--t) ease-(--ease)" style={{ transform: open ? 'rotate(0)' : 'rotate(-90deg)' }} />
				</span>
				<MarkTile mark={mark} size={16} className="rounded-mark" />
				<span className="min-w-0 flex-auto truncate text-body text-(--text-2)" title={approval.tool}>
					<span className="font-medium">{verb}</span> <span className="font-mono text-small">{action}</span> <span className="text-(--text-3)">on {name}</span>
				</span>
				<span className="shrink-0 text-small whitespace-nowrap">{status}</span>
			</button>
			<Disclosure open={open} id={detailsId}>
				<div className="mt-1 mb-1 ml-1.5 flex flex-col gap-2.5 border-l border-(--line) pl-[18px]">
					<Section label="Sent" text={args} />
					{approval.state === 'done' && approval.result !== null ? <Section label="Result" text={approval.result} /> : null}
					{approval.state === 'failed' ? <Section label="Error" text={approval.error ?? 'No reason given.'} tone="bad" /> : null}
				</div>
			</Disclosure>
		</section>
	);
});
