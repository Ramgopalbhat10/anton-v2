import { appDb } from './client.ts';

type Row = Record<string, unknown>;

/** `running` holds an approval while its tool call goes, so a second press cannot run it twice. */
export type ToolApprovalState = 'pending' | 'running' | 'done' | 'declined' | 'failed';

/** A connector tool call waiting on the user's Run: what to call, with which arguments, and what it answered. */
export type ToolApproval = {
	id: string;
	sessionId: string;
	/** The connector it belongs to, such as `composio:slack`. */
	connector: string;
	/** The tool's name as the agent called it. */
	tool: string;
	args: Record<string, unknown>;
	/** Everything needed to run it on approval: toolkit, Composio slug and arguments. */
	payload: { toolkit: string; slug: string; args: Record<string, unknown> };
	state: ToolApprovalState;
	result: string | null;
	error: string | null;
	createdAt: string;
	decidedAt: string | null;
};

function toApproval(row: Row): ToolApproval {
	return {
		id: String(row.id),
		sessionId: String(row.session_id),
		connector: String(row.connector),
		tool: String(row.tool),
		args: JSON.parse(String(row.args_json)) as Record<string, unknown>,
		payload: JSON.parse(String(row.payload_json)) as ToolApproval['payload'],
		state: String(row.state) as ToolApprovalState,
		result: row.result == null ? null : String(row.result),
		error: row.error == null ? null : String(row.error),
		createdAt: String(row.created_at),
		decidedAt: row.decided_at == null ? null : String(row.decided_at),
	};
}

export async function insertToolApproval(approval: Omit<ToolApproval, 'state' | 'result' | 'error' | 'decidedAt'>): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO tool_approvals (id, session_id, connector, tool, args_json, payload_json, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
		args: [approval.id, approval.sessionId, approval.connector, approval.tool, JSON.stringify(approval.args), JSON.stringify(approval.payload), approval.createdAt],
	});
}

export async function getToolApproval(id: string): Promise<ToolApproval | null> {
	const db = await appDb();
	const row = (await db.execute({ sql: 'SELECT * FROM tool_approvals WHERE id = ?', args: [id] })).rows[0];
	return row ? toApproval(row) : null;
}

export async function listToolApprovals(sessionId: string): Promise<ToolApproval[]> {
	const db = await appDb();
	return (await db.execute({ sql: 'SELECT * FROM tool_approvals WHERE session_id = ? ORDER BY created_at', args: [sessionId] })).rows.map(toApproval);
}

/** Moves an approval from one state to the next; false when it was no longer in `from`, as when another press got there first. */
export async function moveToolApproval(id: string, from: ToolApprovalState, to: ToolApprovalState, result: { result?: string | null; error?: string | null } = {}): Promise<boolean> {
	const db = await appDb();
	const done = to !== 'pending' && to !== 'running';
	const update = await db.execute({
		sql: `UPDATE tool_approvals SET state = ?, result = COALESCE(?, result), error = COALESCE(?, error), decided_at = ? WHERE id = ? AND state = ?`,
		args: [to, result.result ?? null, result.error ?? null, done ? new Date().toISOString() : null, id, from],
	});
	return update.rowsAffected > 0;
}
