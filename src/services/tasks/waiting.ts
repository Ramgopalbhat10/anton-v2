import { existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { config } from '../../config.ts';
import { bodyOf } from './latest-input.ts';
import { logProblem } from '../../core/log.ts';

export type WaitingMessage = { id: string; text: string; at: string };

/** Queued messages are in no conversation the page loads until the agent reads them, so they are read from the runtime's record (`flue.db`). */
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
