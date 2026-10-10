import { existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { config } from '../config.ts';
import { appDb } from '../db/client.ts';
import { updateSession } from '../db/sessions.ts';
import { logProblem } from './log.ts';

/** Long inputs are kept to what a card can show. */
const MAX_LENGTH = 2000;

/**
 * Keeps a task's latest input: one you typed, a follow-up, or an
 * automation's prompt. The coding agent calls this for every message it is
 * given (`useLatestInput` in `coder.ts`).
 */
export async function recordLatestInput(id: string, text: string, at = new Date()): Promise<void> {
	const input = text.trim();
	if (!input) return;
	// A message answers whatever the agent was waiting on.
	await updateSession(id, { lastInput: input.slice(0, MAX_LENGTH), lastInputAt: at.toISOString(), asking: null }).catch((error: unknown) =>
		logProblem('warn', 'Could not keep the latest input', error, id),
	);
}

/** The message in a stored submission: a bare string, or `{ kind: 'user', body }`. */
function bodyOf(payload: string): string | null {
	const message = (JSON.parse(payload) as { message?: unknown }).message;
	if (typeof message === 'string') return message;
	const user = message as { kind?: string; body?: unknown } | undefined;
	return user?.kind === 'user' && typeof user.body === 'string' ? user.body : null;
}

/**
 * Fills in the latest input of tasks from before it was kept, from the
 * runtime's own record of the messages it accepted (`flue.db`). Best effort,
 * once at start: nothing else in Anton reads the runtime's tables, so if their
 * shape changes, older tasks simply keep showing their first message.
 */
export async function backfillLatestInputs(file = path.join(config.dataDir, 'flue.db')): Promise<number> {
	if (!existsSync(file)) return 0;
	const db = await appDb();
	const missing = new Set((await db.execute('SELECT id FROM sessions WHERE last_input IS NULL')).rows.map((row) => String(row.id)));
	if (!missing.size) return 0;
	const flue = createClient({ url: `file:${file}` });
	try {
		const rows = (await flue.execute('SELECT session_key, payload, accepted_at FROM flue_agent_submissions ORDER BY sequence')).rows;
		const latest = new Map<string, { text: string; at: Date }>();
		for (const row of rows) {
			// `agent-session:["Coder","<task id>","default","default"]`: the coding agent's main conversation.
			const [agent, id, session] = JSON.parse(String(row.session_key).replace(/^agent-session:/, '')) as string[];
			if (agent !== 'Coder' || session !== 'default' || !missing.has(id)) continue;
			const text = bodyOf(String(row.payload));
			if (text?.trim()) latest.set(id, { text, at: new Date(Number(row.accepted_at)) });
		}
		for (const [id, entry] of latest) await recordLatestInput(id, entry.text, entry.at);
		return latest.size;
	} catch (error) {
		logProblem('warn', 'Could not fill in older tasks’ latest inputs', error);
		return 0;
	} finally {
		flue.close();
	}
}
