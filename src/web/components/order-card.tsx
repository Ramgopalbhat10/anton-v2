import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChartCandlestick, Check, TriangleAlert, X } from 'lucide-react';
import { memo, useContext } from 'react';
import { ReplyActions, type ReplyPlace } from '@/components/reply-cards';
import { Btn, Icon, Spinner } from '@/components/signal';
import { api, type OrderAction, type OrderApproval } from '@/lib/api';
import { cn } from '@/lib/utils';

/** The broker tools that ask you to place, change or cancel an order: the thread draws each as the order with Place and Don't place. */
export const isOrderTool = (name: string) => /^[a-z0-9-]+_(place|modify|cancel)_order$/.test(name);

/** The order a call asked for, named at the end of its result. */
export function orderOf(output: unknown): string | null {
	const text = typeof output === 'string' ? output : output && typeof output === 'object' && typeof (output as { output?: unknown }).output === 'string' ? (output as { output: string }).output : '';
	return /\[order:(order_[\w-]+)\]/.exec(text)?.[1] ?? null;
}

const money = (value: number) => `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const time = (at: string | null) => (at ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

/** The order in words, as its card's title. */
export function orderTitle(action: OrderAction): string {
	const name = action.symbol ?? (action.kind === 'place' ? `security ${action.order.securityId}` : `order ${action.kind === 'modify' ? action.change.orderId : action.cancel.orderId}`);
	if (action.kind === 'place') return `${action.order.side === 'BUY' ? 'Buy' : 'Sell'} ${action.order.quantity} ${name}`;
	if (action.kind === 'modify') return `Change ${name}`;
	return `Cancel ${name}`;
}

/** What Place sends, field by field. */
function rows(action: OrderAction): Array<[string, string]> {
	if (action.kind === 'place') {
		const { order } = action;
		return [
			['Price', order.orderType === 'MARKET' ? 'Market (sent as a limit at the live price)' : money(order.limitPrice ?? 0)],
			['Where', `${order.exchange} · ${order.segment} · ${order.product}`],
			['Security', order.securityId],
			...(order.afterMarket ? ([['When', 'After market, for the next session']] as Array<[string, string]>) : []),
			...(order.tag ? ([['Note', order.tag]] as Array<[string, string]>) : []),
		];
	}
	if (action.kind === 'modify') {
		return [
			['Order', action.change.orderId],
			['New quantity', String(action.change.quantity)],
			['New price', money(action.change.limitPrice)],
		];
	}
	return [
		['Order', action.cancel.orderId],
		['Segment', action.cancel.segment],
	];
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 gap-2 text-[12px] leading-[18px]">
			<span className="w-24 shrink-0 text-(--text-tertiary)">{label}</span>
			<span className="min-w-0 flex-1 break-words text-(--text-primary)">{value}</span>
		</div>
	);
}

const PLACE: Record<OrderAction['kind'], string> = { place: 'Place', modify: 'Change', cancel: 'Cancel order' };

/** What the agent is told once you decide, as your next message. */
function answer(order: OrderApproval, placed: boolean): string {
	const title = orderTitle(order.action);
	if (!placed) return `Don't do it: "${title}".`;
	if (order.state === 'done') return `Done on ${order.brokerName}: "${title}"${order.orderId ? `, order ${order.orderId}` : ''}.`;
	if (order.state === 'unknown') return `I pressed Place for "${title}", but ${order.brokerName} did not answer (${order.problem ?? 'no reply'}). Check the order book before anything else; do not ask again until we know.`;
	return `${order.brokerName} refused "${title}": ${order.problem ?? 'no reason given'}.`;
}

/**
 * An order the agent asked for, as it will go: Place sends it from Anton's
 * server, never from the agent, within the limits set in Settings › Trading,
 * and the agent hears how it went as your next message. What happened is kept
 * on the server, so a reload shows it.
 */
export const OrderCard = memo(function OrderCard({ sessionId, approvalId, place }: { sessionId: string; approvalId: string; place: ReplyPlace }) {
	const { send: reply, busy } = useContext(ReplyActions);
	const queryClient = useQueryClient();
	const orders = useQuery({ queryKey: ['orders', sessionId], queryFn: () => api.orderApprovals(sessionId) });
	const order = orders.data?.orders.find((item) => item.id === approvalId);
	const decide = useMutation({
		mutationFn: (go: boolean) => api.decideOrder(sessionId, approvalId, go),
		onSuccess: (next, go) => {
			queryClient.setQueryData<{ orders: OrderApproval[] }>(['orders', sessionId], (current) => (current ? { orders: current.orders.map((item) => (item.id === next.id ? next : item)) } : current));
			// The agent waits for an answer; one already working hears of it when it next reads the thread.
			if (place.latest && !busy) reply(answer(next, go));
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: ['orders', sessionId] }),
	});
	if (!order) {
		return orders.isPending ? (
			<div className="flex h-9 items-center gap-2 rounded-[12px] border border-dashed border-(--card-border) px-3 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				Preparing the order
			</div>
		) : null;
	}
	const pending = order.state === 'pending' || order.state === 'sending';
	const sell = order.action.kind === 'place' && order.action.order.side === 'SELL';
	const status =
		order.state === 'done' ? (
			<span className="inline-flex items-center gap-1.5 text-(--success-text)">
				<Icon icon={Check} size={12} />
				{order.action.kind === 'cancel' ? 'Cancelled' : order.action.kind === 'modify' ? 'Changed' : 'Placed'} {time(order.decidedAt)}
				{order.orderId ? ` · ${order.orderId}` : ''}
			</span>
		) : order.state === 'declined' ? (
			<span className="inline-flex items-center gap-1.5 text-(--text-tertiary)">
				<Icon icon={X} size={12} />
				Not placed
			</span>
		) : order.state === 'failed' ? (
			<span className="text-(--danger-text)">Refused: {order.problem}</span>
		) : order.state === 'unknown' ? (
			<span className="inline-flex items-center gap-1.5 text-(--warning-text)">
				<Icon icon={TriangleAlert} size={12} />
				Sent, but no answer came. Check the order book before placing it again.
			</span>
		) : order.state === 'expired' ? (
			<span className="text-(--text-tertiary)">Not answered within 30 minutes, so it was not placed.</span>
		) : null;
	return (
		<section className="in-card overflow-hidden" aria-label="Order to place">
			<header className="flex items-start gap-2.5 px-3.5 pt-3 pb-2">
				<span className={cn('mt-px inline-flex size-[22px] shrink-0 items-center justify-center rounded-[7px]', sell ? 'bg-(--danger-bg) text-(--danger-text)' : 'bg-(--accent-bg-subtle) text-(--accent-text)')}>
					<Icon icon={ChartCandlestick} size={13} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h3 className="m-0 truncate text-[13px] leading-[20px] font-medium text-(--text-primary)">{orderTitle(order.action)}</h3>
					<span className="text-[11.5px] text-(--text-tertiary)">
						{pending ? `The agent asks to send this to ${order.brokerName}` : `Order on ${order.brokerName}`}
						{order.value !== null ? ` · worth about ${money(order.value)}` : ''}
					</span>
				</div>
			</header>
			<div className="flex flex-col gap-0.5 px-3.5 pb-3">
				{rows(order.action).map(([label, value]) => (
					<Row key={label} label={label} value={value} />
				))}
			</div>
			<footer className="flex min-h-11 flex-wrap items-center justify-end gap-2 border-t border-(--border-subtle) px-3.5 py-2 text-[12px]">
				{decide.error ? <span className="mr-auto text-(--danger-text)">{decide.error.message}</span> : null}
				{status ? <span className="mr-auto">{status}</span> : null}
				{pending ? (
					<>
						<Btn size="sm" variant="ghost" disabled={decide.isPending || order.state === 'sending'} onClick={() => decide.mutate(false)}>
							Don't place
						</Btn>
						<Btn size="sm" variant="primary" icon={ChartCandlestick} disabled={decide.isPending || order.state === 'sending'} onClick={() => decide.mutate(true)}>
							{decide.isPending || order.state === 'sending' ? 'Sending…' : PLACE[order.action.kind]}
						</Btn>
					</>
				) : null}
			</footer>
		</section>
	);
});
