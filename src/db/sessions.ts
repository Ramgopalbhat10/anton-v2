import type { Reasoning } from '../core/ports.ts';
import type { SessionRecord, Usage } from '../core/types.ts';
import { appDb } from './client.ts';

type Row = Record<string, unknown>;
const optional = (value: unknown) => (value == null ? null : String(value));

function toRecord(row: Row): SessionRecord {
	return {
		id: String(row.id),
		projectId: String(row.project_id),
		repo: String(row.repo ?? ''),
		title: String(row.title),
		model: String(row.model),
		reasoning: optional(row.reasoning) as Reasoning | null,
		branch: String(row.branch ?? ''),
		baseBranch: String(row.base_branch ?? ''),
		baseSha: String(row.base_sha ?? ''),
		prUrl: optional(row.pr_url),
		errorMessage: optional(row.error_message),
		checkpointAt: optional(row.checkpoint_at),
		createdAt: String(row.created_at),
		failed: row.status === 'error',
		machineState: optional(row.machine_state),
		usage: { inputTokens: Number(row.input_tokens ?? 0), outputTokens: Number(row.output_tokens ?? 0), cost: Number(row.cost_usd ?? 0) },
		legacySetup: Number(row.legacy_setup ?? 0) === 1,
	};
}

/** Adds one response's usage to the task's totals and to the log daily caps are counted from. */
export async function addSessionUsage(id: string, usage: Usage, at = new Date()): Promise<void> {
	const db = await appDb();
	await db.batch(
		[
			{
				sql: 'UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?',
				args: [usage.inputTokens, usage.outputTokens, usage.cost, id],
			},
			{
				sql: 'INSERT INTO usage_log (session_id, at, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)',
				args: [id, at.toISOString(), usage.inputTokens, usage.outputTokens, usage.cost],
			},
		],
		'write',
	);
}

/** Dollars spent on every task since `since`. */
export async function spentSince(since: Date): Promise<number> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM usage_log WHERE at >= ?', args: [since.toISOString()] });
	return Number(result.rows[0]?.cost ?? 0);
}

export type NewSession = Pick<SessionRecord, 'id' | 'projectId' | 'title' | 'model' | 'reasoning' | 'branch' | 'baseBranch' | 'baseSha'>;

const SELECT = 'SELECT s.*, p.repo_full_name AS repo FROM sessions s JOIN projects p ON p.id = s.project_id';

export async function insertSession(session: NewSession): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO sessions (id, project_id, flue_conversation_id, status, model, reasoning, title, branch, base_branch, base_sha, created_at)
			VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			session.id,
			session.projectId,
			session.id,
			session.model,
			session.reasoning,
			session.title,
			session.branch,
			session.baseBranch,
			session.baseSha,
			new Date().toISOString(),
		],
	});
}

export async function listSessionRecords(): Promise<SessionRecord[]> {
	const db = await appDb();
	const result = await db.execute(`${SELECT} WHERE s.base_sha IS NOT NULL ORDER BY s.created_at DESC`);
	return result.rows.map((row) => toRecord(row as Row));
}

export async function getSessionRecord(id: string): Promise<SessionRecord | null> {
	const db = await appDb();
	const result = await db.execute({ sql: `${SELECT} WHERE s.id = ?`, args: [id] });
	return result.rows[0] ? toRecord(result.rows[0] as Row) : null;
}

const columns = {
	title: 'title',
	model: 'model',
	reasoning: 'reasoning',
	prUrl: 'pr_url',
	machineState: 'machine_state',
	checkpointAt: 'checkpoint_at',
	errorMessage: 'error_message',
} as const;

export type SessionUpdate = Partial<{ [K in keyof typeof columns]: string | null }> & { failed?: boolean };

export async function updateSession(id: string, update: SessionUpdate): Promise<void> {
	const entries = Object.entries(columns).filter(([key]) => key in update);
	const sets = entries.map(([, column]) => `${column} = ?`);
	const args = entries.map(([key]) => update[key as keyof typeof columns] ?? null);
	if (update.failed !== undefined) {
		sets.push('status = ?');
		args.push(update.failed ? 'error' : 'stopped');
	}
	if (sets.length === 0) return;
	const db = await appDb();
	await db.execute({ sql: `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id] });
}

export async function deleteSessionRecord(id: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [id] });
}
