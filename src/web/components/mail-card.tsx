import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Mail, Send, X } from 'lucide-react';
import { memo, useContext } from 'react';
import { ReplyActions, type ReplyPlace } from '@/components/reply-cards';
import { Btn, Icon, Spinner } from '@/components/signal';
import { api, type MailApproval } from '@/lib/api';
import { cn } from '@/lib/utils';

/** The tools that ask the user to send an email: the thread draws each as the email with Send and Don't send. */
export const MAIL_SEND_TOOLS = new Set(['gmail_send']);

/** The approval a send call made, named at the end of its result. */
export function approvalOf(output: unknown): string | null {
	const text = typeof output === 'string' ? output : output && typeof output === 'object' && typeof (output as { output?: unknown }).output === 'string' ? (output as { output: string }).output : '';
	return /\[approval:(mail_[\w-]+)\]/.exec(text)?.[1] ?? null;
}

const time = (at: string | null) => (at ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 gap-2 text-[12px] leading-[18px]">
			<span className="w-14 shrink-0 text-(--text-tertiary)">{label}</span>
			<span className="min-w-0 flex-1 break-words text-(--text-primary)">{value}</span>
		</div>
	);
}

/**
 * An email the agent asked to send, as it will go: Send sends it from Anton's
 * server, never from the agent, and the agent hears of it as your next message.
 * What happened is kept on the server, so a reload shows it.
 */
export const MailSendCard = memo(function MailSendCard({ sessionId, approvalId, place }: { sessionId: string; approvalId: string; place: ReplyPlace }) {
	const { send: reply, busy } = useContext(ReplyActions);
	const queryClient = useQueryClient();
	const approvals = useQuery({ queryKey: ['mail', sessionId], queryFn: () => api.mailApprovals(sessionId) });
	const approval = approvals.data?.approvals.find((item) => item.id === approvalId);
	const decide = useMutation({
		mutationFn: (send: boolean) => api.decideMail(sessionId, approvalId, send),
		onSuccess: (next, send) => {
			queryClient.setQueryData<{ approvals: MailApproval[] }>(['mail', sessionId], (current) =>
				current ? { approvals: current.approvals.map((item) => (item.id === next.id ? next : item)) } : current,
			);
			// The agent waits for an answer; one already working hears of it when it next reads the thread.
			if (place.latest && !busy) reply(send ? `I sent the email "${next.subject}".` : `Don't send the email "${next.subject}".`);
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['mail', sessionId] }),
	});
	if (!approval) {
		return approvals.isPending ? (
			<div className="flex h-9 items-center gap-2 rounded-[12px] border border-dashed border-(--card-border) px-3 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				Preparing the email
			</div>
		) : null;
	}
	const pending = approval.state === 'pending' || approval.state === 'sending';
	const status =
		approval.state === 'sent' ? (
			<span className="inline-flex items-center gap-1.5 text-(--success-text)">
				<Icon icon={Check} size={12} />
				Sent {time(approval.decidedAt)}
			</span>
		) : approval.state === 'declined' ? (
			<span className="inline-flex items-center gap-1.5 text-(--text-tertiary)">
				<Icon icon={X} size={12} />
				Not sent
			</span>
		) : approval.state === 'changed' ? (
			<span className="text-(--warning-text)">The draft changed after you were shown it, so it was not sent.</span>
		) : null;
	return (
		<section className="in-card overflow-hidden" aria-label="Email to send">
			<header className="flex items-start gap-2.5 px-3.5 pt-3 pb-2">
				<span className="mt-px inline-flex size-[22px] shrink-0 items-center justify-center rounded-[7px] border border-dashed border-(--accent-border) text-(--accent-text)">
					<Icon icon={Mail} size={12} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h3 className="m-0 truncate text-[13px] leading-[20px] font-medium text-(--text-primary)">{approval.subject || '(no subject)'}</h3>
					<span className="text-[11.5px] text-(--text-tertiary)">{pending ? 'The agent asks to send this from Gmail' : 'Email from Gmail'}</span>
				</div>
			</header>
			<div className="flex flex-col gap-0.5 px-3.5 pb-2">
				<Row label="To" value={approval.to.join(', ')} />
				{approval.cc.length ? <Row label="Cc" value={approval.cc.join(', ')} /> : null}
				{approval.bcc.length ? <Row label="Bcc" value={approval.bcc.join(', ')} /> : null}
			</div>
			<div
				className={cn(
					'mx-3.5 mb-3 overflow-auto rounded-[10px] border border-(--border-subtle) bg-(--well-bg) px-3 py-2 text-[12.5px] leading-[19px] whitespace-pre-wrap text-(--text-secondary)',
					pending ? 'max-h-[320px]' : 'max-h-[120px]',
				)}
			>
				{approval.body}
			</div>
			<footer className="flex min-h-11 flex-wrap items-center justify-end gap-2 border-t border-(--border-subtle) px-3.5 py-2 text-[12px]">
				{decide.error ? <span className="mr-auto text-(--danger-text)">{decide.error.message}</span> : null}
				{status ? <span className="mr-auto">{status}</span> : null}
				{pending ? (
					<>
						<Btn size="sm" variant="ghost" disabled={decide.isPending || approval.state === 'sending'} onClick={() => decide.mutate(false)}>
							Don't send
						</Btn>
						<Btn size="sm" variant="primary" icon={Send} disabled={decide.isPending || approval.state === 'sending'} onClick={() => decide.mutate(true)}>
							{decide.isPending || approval.state === 'sending' ? 'Sending…' : 'Send'}
						</Btn>
					</>
				) : null}
			</footer>
		</section>
	);
});
