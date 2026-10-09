import type { Reasoning } from '../core/ports.ts';
import type { PullRequestStatus, SessionRecord, Usage } from '../core/types.ts';
import { announce } from '../core/changes.ts';
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
		followState: optional(row.follow_json),
		usage: { inputTokens: Number(row.input_tokens ?? 0), outputTokens: Number(row.output_tokens ?? 0), cost: Number(row.cost_usd ?? 0) },
		legacySetup: Number(row.legacy_setup ?? 0) === 1,
		planMode: Number(row.plan_mode ?? 0) === 1,
		pinnedAt: optional(row.pinned_at),
		pullRequest: pullRequestOf(row),
		lastInput: optional(row.last_input),
		lastInputAt: optional(row.last_input_at),
	};
}

/** The saved status, only while it is for the task's current pull request. */
function pullRequestOf(row: Row): PullRequestStatus | null {
	if (row.pr_json == null || row.pr_url == null) return null;
	// `runs` is missing from statuses saved before it was kept.
	const { url, ...status } = JSON.parse(String(row.pr_json)) as Omit<PullRequestStatus, 'runs'> & { url: string; runs?: PullRequestStatus['runs'] };
	return url === row.pr_url ? { ...status, runs: status.runs ?? [] } : null;
}

/** Adds one response's usage to the task's totals and to the log daily caps are counted from. */
/** `model` is the one that did the work, when it is not the task's own (a subagent's, or the decision model). */
export async function addSessionUsage(id: string, usage: Usage, at = new Date(), model: string | null = null, turnId: string | null = null): Promise<boolean> {
	const db = await appDb();
	const result = await db.batch(
		[
			{
				sql: `INSERT INTO usage_log (session_id, at, input_tokens, output_tokens, cost_usd, project_id, model, turn_id)
					VALUES (?, ?, ?, ?, ?, (SELECT project_id FROM sessions WHERE id = ?), COALESCE(?, (SELECT model FROM sessions WHERE id = ?)), ?)
					ON CONFLICT (session_id, turn_id) WHERE turn_id IS NOT NULL DO NOTHING`,
				args: [id, at.toISOString(), usage.inputTokens, usage.outputTokens, usage.cost, id, model, id, turnId],
			},
			{
				// changes() refers to the insert immediately above, on the same transaction/connection.
				sql: 'UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ? WHERE id = ? AND changes() > 0',
				args: [usage.inputTokens, usage.outputTokens, usage.cost, id],
			},
		],
		'write',
	);
	return result[0].rowsAffected > 0;
}

/** Dollars spent on every task since `since`. */
export async function spentSince(since: Date): Promise<number> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM usage_log WHERE at >= ?', args: [since.toISOString()] });
	return Number(result.rows[0]?.cost ?? 0);
}

/** Spend since a time grouped by one key; `key` is null for responses logged before it was recorded. */
export type SpendRow = { key: string | null; tokens: number; cost: number };

const GROUPS = { repo: 'p.repo_full_name', model: 'u.model' } as const;

/** Dollars and tokens since `since`, by repository or by model, most spent first. */
export async function spendBy(group: keyof typeof GROUPS, since: Date): Promise<SpendRow[]> {
	const db = await appDb();
	const result = await db.execute({
		sql: `SELECT ${GROUPS[group]} AS key, SUM(u.input_tokens + u.output_tokens) AS tokens, SUM(u.cost_usd) AS cost
			FROM usage_log u LEFT JOIN projects p ON p.id = u.project_id
			WHERE u.at >= ? GROUP BY 1 ORDER BY cost DESC`,
		args: [since.toISOString()],
	});
	return result.rows.map((row) => ({ key: row.key == null ? null : String(row.key), tokens: Number(row.tokens), cost: Number(row.cost) }));
}

/** Every model call a task made, the subagents' and compaction's included, and the tokens they processed in all. */
export async function sessionCalls(id: string): Promise<{ calls: number; tokens: number }> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM usage_log WHERE session_id = ?', args: [id] });
	return { calls: Number(result.rows[0]?.calls ?? 0), tokens: Number(result.rows[0]?.tokens ?? 0) };
}

/** Input and output tokens and calls since `since` for models whose id starts with `prefix`, per minute in UTC and model. */
export async function tokensByMinute(prefix: string, since: Date): Promise<Array<{ minute: string; model: string; input: number; output: number; calls: number }>> {
	const db = await appDb();
	const result = await db.execute({
		sql: `SELECT substr(at, 1, 16) AS minute, model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS calls
			FROM usage_log WHERE at >= ? AND model LIKE ? GROUP BY 1, 2 ORDER BY 1`,
		args: [since.toISOString(), `${prefix.replace(/[%_]/g, '')}%`],
	});
	return result.rows.map((row) => ({ minute: String(row.minute), model: String(row.model), input: Number(row.input), output: Number(row.output), calls: Number(row.calls) }));
}

/** Dollars and tokens since `since` by model, per minute in UTC, so callers can bucket them into local days. */
export async function spendByMinute(since: Date): Promise<Array<{ minute: string; model: string | null; tokens: number; cost: number }>> {
	const db = await appDb();
	const result = await db.execute({
		sql: `SELECT substr(at, 1, 16) AS minute, model, SUM(input_tokens + output_tokens) AS tokens, SUM(cost_usd) AS cost
			FROM usage_log WHERE at >= ? GROUP BY 1, 2 ORDER BY 1`,
		args: [since.toISOString()],
	});
	return result.rows.map((row) => ({
		minute: String(row.minute),
		model: row.model == null ? null : String(row.model),
		tokens: Number(row.tokens),
		cost: Number(row.cost),
	}));
}

export type NewSession = Pick<SessionRecord, 'id' | 'projectId' | 'title' | 'model' | 'reasoning' | 'branch' | 'baseBranch' | 'baseSha' | 'planMode'>;

const SELECT = 'SELECT s.*, p.repo_full_name AS repo FROM sessions s JOIN projects p ON p.id = s.project_id';

export async function insertSession(session: NewSession): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO sessions (id, project_id, flue_conversation_id, status, model, reasoning, title, branch, base_branch, base_sha, plan_mode, created_at)
			VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			session.planMode ? 1 : 0,
			new Date().toISOString(),
		],
	});
	announce({ kind: 'sessions' });
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
	followState: 'follow_json',
	pinnedAt: 'pinned_at',
	pullRequestJson: 'pr_json',
	lastInput: 'last_input',
	lastInputAt: 'last_input_at',
} as const;

export type SessionUpdate = Partial<{ [K in keyof typeof columns]: string | null }> & { failed?: boolean; planMode?: boolean };

export async function updateSession(id: string, update: SessionUpdate): Promise<void> {
	const entries = Object.entries(columns).filter(([key]) => key in update);
	const sets = entries.map(([, column]) => `${column} = ?`);
	const args: Array<string | number | null> = entries.map(([key]) => update[key as keyof typeof columns] ?? null);
	if (update.failed !== undefined) {
		sets.push('status = ?');
		args.push(update.failed ? 'error' : 'stopped');
	}
	if (update.planMode !== undefined) {
		sets.push('plan_mode = ?');
		args.push(update.planMode ? 1 : 0);
	}
	if (sets.length === 0) return;
	const db = await appDb();
	await db.execute({ sql: `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id] });
	announce({ kind: 'task', id, what: 'state' });
}

export async function deleteSessionRecord(id: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [id] });
	announce({ kind: 'sessions' });
}
