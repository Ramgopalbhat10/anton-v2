import type { BrokerCancel, BrokerOrder, BrokerOrderChange } from '../core/ports.ts';
import { appDb } from './client.ts';

type Row = Record<string, unknown>;

/**
 * `sending` holds an approval while it goes to the broker, so a second press cannot place it twice.
 * `failed` is a refusal by the broker; `unknown` means no answer came, so the order may have gone.
 */
export type OrderApprovalState = 'pending' | 'sending' | 'done' | 'declined' | 'failed' | 'unknown' | 'expired';

export type OrderAction =
	| { kind: 'place'; order: BrokerOrder; symbol: string | null }
	| { kind: 'modify'; change: BrokerOrderChange; symbol: string | null }
	| { kind: 'cancel'; cancel: BrokerCancel; symbol: string | null };

export type OrderApproval = {
	id: string;
	sessionId: string;
	broker: string;
	action: OrderAction;
	/** What the order was worth when asked (quantity times its price), in the broker's currency; null for a cancel. */
	value: number | null;
	state: OrderApprovalState;
	createdAt: string;
	decidedAt: string | null;
	orderId: string | null;
	problem: string | null;
};

function toApproval(row: Row): OrderApproval {
	return {
		id: String(row.id),
		sessionId: String(row.session_id),
		broker: String(row.broker),
		action: JSON.parse(String(row.order_json)) as OrderAction,
		value: row.value == null ? null : Number(row.value),
		state: String(row.state) as OrderApprovalState,
		createdAt: String(row.created_at),
		decidedAt: row.decided_at == null ? null : String(row.decided_at),
		orderId: row.order_id == null ? null : String(row.order_id),
		problem: row.problem == null ? null : String(row.problem),
	};
}

export async function insertOrderApproval(approval: Pick<OrderApproval, 'id' | 'sessionId' | 'broker' | 'action' | 'value' | 'createdAt'>): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO order_approvals (id, session_id, broker, action, order_json, value, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
		args: [approval.id, approval.sessionId, approval.broker, approval.action.kind, JSON.stringify(approval.action), approval.value, approval.createdAt],
	});
}

export async function getOrderApproval(id: string): Promise<OrderApproval | null> {
	const db = await appDb();
	const row = (await db.execute({ sql: 'SELECT * FROM order_approvals WHERE id = ?', args: [id] })).rows[0];
	return row ? toApproval(row) : null;
}

export async function listOrderApprovals(sessionId: string): Promise<OrderApproval[]> {
	const db = await appDb();
	return (await db.execute({ sql: 'SELECT * FROM order_approvals WHERE session_id = ? ORDER BY created_at', args: [sessionId] })).rows.map(toApproval);
}

/** New orders a broker took or may have taken since `since` (ISO), from every task: what the daily cap counts. */
export async function ordersPlacedSince(broker: string, since: string): Promise<number> {
	const db = await appDb();
	const result = await db.execute({
		sql: `SELECT COUNT(*) AS n FROM order_approvals WHERE broker = ? AND action = 'place' AND state IN ('done', 'unknown', 'sending') AND COALESCE(decided_at, created_at) >= ?`,
		args: [broker, since],
	});
	return Number(result.rows[0]?.n ?? 0);
}

/** Moves an approval from one state to the next; false when it was no longer in `from`, as when another press got there first. */
export async function moveOrderApproval(id: string, from: OrderApprovalState, to: OrderApprovalState, outcome: { orderId?: string; problem?: string } = {}): Promise<boolean> {
	const db = await appDb();
	const result = await db.execute({
		sql: `UPDATE order_approvals SET state = ?, decided_at = ?, order_id = COALESCE(?, order_id), problem = ? WHERE id = ? AND state = ?`,
		args: [to, to === 'pending' ? null : new Date().toISOString(), outcome.orderId ?? null, outcome.problem ?? null, id, from],
	});
	return result.rowsAffected > 0;
}
