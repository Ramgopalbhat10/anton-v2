import type { Trace } from '../core/trace.ts';
import { appDb } from './client.ts';

export const KEEP_TRACES = 100;

/** The latest traces, also kept in memory: a trace whose save failed (a locked database, say) still opens until a restart. */
const recent = new Map<string, Trace>();
const KEEP_IN_MEMORY = 50;

export async function saveTrace(trace: Trace): Promise<void> {
	recent.delete(`${trace.sessionId}/${trace.id}`);
	recent.set(`${trace.sessionId}/${trace.id}`, trace);
	for (const key of recent.keys()) {
		if (recent.size <= KEEP_IN_MEMORY) break;
		recent.delete(key);
	}
	const db = await appDb();
	await db.batch(
		[
			{ sql: 'INSERT OR REPLACE INTO response_traces (id, session_id, created_at, trace_json) VALUES (?, ?, ?, ?)', args: [trace.id, trace.sessionId, trace.startedAt, JSON.stringify(trace)] },
			{
				sql: 'DELETE FROM response_traces WHERE session_id = ? AND id NOT IN (SELECT id FROM response_traces WHERE session_id = ? ORDER BY created_at DESC LIMIT ?)',
				args: [trace.sessionId, trace.sessionId, KEEP_TRACES],
			},
		],
		'write',
	);
}

export async function getTrace(sessionId: string, id: string): Promise<Trace | null> {
	const kept = recent.get(`${sessionId}/${id}`);
	if (kept) return kept;
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT trace_json FROM response_traces WHERE session_id = ? AND id = ?', args: [sessionId, id] });
	const row = result.rows[0];
	return row ? (JSON.parse(String(row.trace_json)) as Trace) : null;
}

/** The trace of a reply that failed or was stopped, by any submission it settled (`src/services/replies/settled-reply.ts`). */
export async function getSettledTrace(sessionId: string, submissionId: string): Promise<Trace | null> {
	for (const trace of [...recent.values()].reverse()) if (trace.sessionId === sessionId && trace.settled?.submissions.includes(submissionId)) return trace;
	const db = await appDb();
	const result = await db.execute({
		sql: "SELECT trace_json FROM response_traces WHERE session_id = ? AND json_valid(trace_json) AND EXISTS (SELECT 1 FROM json_each(trace_json, '$.settled.submissions') WHERE value = ?) ORDER BY created_at DESC LIMIT 1",
		args: [sessionId, submissionId],
	});
	const row = result.rows[0];
	return row ? (JSON.parse(String(row.trace_json)) as Trace) : null;
}
