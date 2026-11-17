import { useQueryClient } from '@tanstack/react-query';
import { ListChecks } from '@/lib/icons';
import { memo, useState } from 'react';
import { field } from '@/components/thread/tool-describe';
import { Markdown } from '@/components/content/markdown';
import { Badge, Btn, Icon, Spinner } from '@/components/kit/signal';
import { StatusDot } from '@/components/kit/instrument';
import { type Session } from '@/lib/api/sessions';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { type ToolPart } from '@/components/thread/blocks';

const APPROVED = 'Your plan is approved. Go ahead and build it.';

export const PlanCard = memo(function PlanCard({ part, answer }: { part: ToolPart; answer: string | null }) {
	const plan = field(part.input, 'plan');
	// A plan that waits on you carries the accent's line; once approved it is a plain card again.
	const proposed = Boolean(plan) && answer !== APPROVED;
	return (
		<div className={cn('in-card overflow-hidden', proposed && 'shadow-[inset_0_0_0_1px_var(--accent-line)]')}>
			<div className="flex h-10 items-center gap-2 border-b border-(--line) px-3">
				<Icon icon={ListChecks} size={14} className="text-(--text-3)" />
				<span className="text-body font-medium">{proposed ? 'Proposed plan' : 'Plan'}</span>
				<span className="ml-auto">
					<Badge tone={!plan ? 'neutral' : answer === APPROVED ? 'success' : 'accent'}>{!plan ? 'Writing' : answer === APPROVED ? 'Approved' : 'Proposed'}</Badge>
				</span>
			</div>
			<div className="px-3.5 pt-3 pb-3.5">{plan ? <Markdown text={plan} /> : <Spinner size={12} />}</div>
		</div>
	);
});

/** Approving turns plan mode off first, so the agent has its full tools for the message that follows. */
export function ApproveBar({ sessionId, send }: { sessionId: string; send: (text: string) => Promise<void> }) {
	const queryClient = useQueryClient();
	const [approving, setApproving] = useState(false);
	const approve = async () => {
		setApproving(true);
		try {
			const updated = await api.editSession(sessionId, { planMode: false });
			queryClient.setQueryData<Session>(['session', sessionId], updated);
			await send(APPROVED);
		} finally {
			setApproving(false);
		}
	};
	return (
		<div className="in-callout in-callout--accent mx-auto mt-2 flex w-[calc(100%-32px)] max-w-[720px] items-center gap-2.5 py-1.5 pr-1.5 pl-3">
			<StatusDot tone="accent" />
			<span className="min-w-0 flex-1 text-body text-(--text)">
				The plan is ready. Approve it to let Anton build it, or reply to change it.
			</span>
			<Btn size="sm" variant="primary" disabled={approving} onClick={() => void approve()}>
				{approving ? 'Approving…' : 'Approve and build'}
			</Btn>
		</div>
	);
}
