import type { SessionRecord } from '../core/types.ts';
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
		branch: String(row.branch ?? ''),
		baseBranch: String(row.base_branch ?? ''),
		baseSha: String(row.base_sha ?? ''),
		prUrl: optional(row.pr_url),
		errorMessage: optional(row.error_message),
		checkpointAt: optional(row.checkpoint_at),
		createdAt: String(row.created_at),
		failed: row.status === 'error',
		machineState: optional(row.machine_state),
	};
}

export type NewSession = Pick<SessionRecord, 'id' | 'projectId' | 'title' | 'model' | 'branch' | 'baseBranch' | 'baseSha'>;

const SELECT = 'SELECT s.*, p.repo_full_name AS repo FROM sessions s JOIN projects p ON p.id = s.project_id';

export async function insertSession(session: NewSession): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO sessions (id, project_id, flue_conversation_id, status, model, title, branch, base_branch, base_sha, created_at)
			VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?)`,
		args: [
			session.id,
			session.projectId,
			session.id,
			session.model,
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
	model: 'model',
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
