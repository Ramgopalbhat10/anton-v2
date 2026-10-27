import { existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { config } from '../config.ts';
import { bodyOf } from './latest-input.ts';
import { logProblem } from './log.ts';

/** A message the runtime accepted for the task but the agent has not read yet. */
export type WaitingMessage = { id: string; text: string; at: string };

/**
 * Messages sent while the agent works wait in the runtime's queue until it
 * reads them between two steps. Until then they are in no conversation the
 * page loads, only in the page that sent them, so leaving the thread lost
 * them from view. They are read from the runtime's own record (`flue.db`),
 * as `backfillLatestInputs` does; one a Stop is dropping is no longer listed.
 */
export async function waitingMessages(id: string, file = path.join(config.dataDir, 'flue.db')): Promise<WaitingMessage[]> {
	if (!existsSync(file)) return [];
	const flue = createClient({ url: `file:${file}` });
	try {
		const rows = (
			await flue.execute({
				sql: "SELECT submission_id, payload, accepted_at FROM flue_agent_submissions WHERE session_key = ? AND status = 'queued' AND abort_requested_at IS NULL ORDER BY sequence",
				args: [`agent-session:${JSON.stringify(['Coder', id, 'default', 'default'])}`],
			})
		).rows;
		return rows.flatMap((row) => {
			const text = bodyOf(String(row.payload));
			return text?.trim() ? [{ id: String(row.submission_id), text, at: new Date(Number(row.accepted_at)).toISOString() }] : [];
		});
	} catch (error) {
		logProblem('warn', 'Could not read the messages waiting for the agent', error, id);
		return [];
	} finally {
		flue.close();
	}
}
