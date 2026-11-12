import { appDb } from './client.ts';

/** A task's saved gate state, as JSON; null when it has none. */
export async function getGateStateRow(sessionId: string): Promise<string | null> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT state_json FROM task_gate_state WHERE session_id = ?', args: [sessionId] });
	const row = result.rows[0];
	return row ? String(row.state_json) : null;
}

/**
 * Saves a task's gate state in place of the last. A task this database deleted gets no row back: a write queued
 * while it was deleted would otherwise leave one that nothing removes.
 */
export async function saveGateStateRow(sessionId: string, json: string, at = new Date()): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO task_gate_state (session_id, state_json, updated_at)
			SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_sessions WHERE session_id = ?)
			ON CONFLICT (session_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
		args: [sessionId, json, at.toISOString(), sessionId],
	});
}
