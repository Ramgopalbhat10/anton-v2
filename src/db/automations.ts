import { randomUUID } from 'node:crypto';
import type { Reasoning } from '../core/ports.ts';
import { appDb } from './client.ts';

/** A way tasks start without anyone typing: from labeled issues, or every few hours. */
export type Automation = {
	id: string;
	projectId: string;
	kind: 'issues' | 'schedule';
	/** Issues with this label start tasks (kind `issues`). */
	label: string | null;
	/** Hours between runs (kind `schedule`). */
	everyHours: number | null;
	/** The task's instructions; for issues, added after the issue itself. */
	prompt: string;
	/** Model for the tasks it starts; null uses the default. */
	model: string | null;
	/** Reasoning level for that model; null uses the model's default. */
	reasoning: Reasoning | null;
	/** Its tasks start in plan mode: they propose a plan and change nothing until it is approved. */
	planFirst: boolean;
	enabled: boolean;
	lastRunAt: string | null;
	lastError: string | null;
	/** Issue numbers this automation started a task for. */
	seen: number[];
	/** The project its tasks start in, as threads; null for tasks of their own. */
	spaceId: string | null;
	createdAt: string;
};

type Row = Record<string, unknown>;
const optional = (value: unknown) => (value == null ? null : String(value));

function toAutomation(row: Row): Automation {
	return {
		id: String(row.id),
		projectId: String(row.project_id),
		kind: String(row.kind) as Automation['kind'],
		label: optional(row.label),
		everyHours: row.every_hours == null ? null : Number(row.every_hours),
		prompt: String(row.prompt),
		model: optional(row.model),
		reasoning: optional(row.reasoning) as Reasoning | null,
		planFirst: Number(row.plan_first ?? 0) === 1,
		enabled: Number(row.enabled) === 1,
		lastRunAt: optional(row.last_run_at),
		lastError: optional(row.last_error),
		seen: (JSON.parse(String(row.seen_json ?? '[]')) as Array<number | null>).filter((number): number is number => number !== null),
		spaceId: optional(row.space_id),
		createdAt: String(row.created_at),
	};
}

export type NewAutomation = Pick<Automation, 'projectId' | 'kind' | 'label' | 'everyHours' | 'prompt' | 'model' | 'reasoning' | 'planFirst'> & { spaceId?: string | null };

export async function insertAutomation(input: NewAutomation): Promise<Automation> {
	const db = await appDb();
	const id = `auto_${randomUUID()}`;
	await db.execute({
		sql: `INSERT INTO automations (id, project_id, kind, label, every_hours, prompt, model, reasoning, plan_first, enabled, created_at, space_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		args: [id, input.projectId, input.kind, input.label, input.everyHours, input.prompt, input.model, input.reasoning, input.planFirst ? 1 : 0, new Date().toISOString(), input.spaceId ?? null],
	});
	return (await getAutomation(id))!;
}

/** Each automation with the issues it started tasks for. */
const SELECT = `SELECT automations.*, (SELECT json_group_array(issue_number) FROM (SELECT issue_number FROM issue_tasks WHERE automation_id = automations.id ORDER BY issue_number)) AS seen_json FROM automations`;

export async function listAutomations(projectId?: string): Promise<Automation[]> {
	const db = await appDb();
	const result = projectId
		? await db.execute({ sql: `${SELECT} WHERE project_id = ? ORDER BY created_at`, args: [projectId] })
		: await db.execute(`${SELECT} ORDER BY created_at`);
	return result.rows.map((row) => toAutomation(row as Row));
}

/** A project's routines: automations whose tasks start as its threads. */
export async function listSpaceAutomations(spaceId: string): Promise<Automation[]> {
	const db = await appDb();
	const result = await db.execute({ sql: `${SELECT} WHERE space_id = ? ORDER BY created_at`, args: [spaceId] });
	return result.rows.map((row) => toAutomation(row as Row));
}

export async function getAutomation(id: string): Promise<Automation | null> {
	const db = await appDb();
	const result = await db.execute({ sql: `${SELECT} WHERE id = ?`, args: [id] });
	return result.rows[0] ? toAutomation(result.rows[0] as Row) : null;
}

const columns = { enabled: 'enabled', lastRunAt: 'last_run_at', lastError: 'last_error' } as const;
export type AutomationUpdate = Partial<Pick<Automation, keyof typeof columns>>;

const stored = (key: keyof typeof columns, value: unknown) => (key === 'enabled' ? (value ? 1 : 0) : ((value as string | null) ?? null));

export async function updateAutomation(id: string, update: AutomationUpdate): Promise<void> {
	const entries = (Object.keys(columns) as Array<keyof typeof columns>).filter((key) => key in update);
	if (entries.length === 0) return;
	const db = await appDb();
	await db.execute({
		sql: `UPDATE automations SET ${entries.map((key) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`,
		args: [...entries.map((key) => stored(key, update[key])), id],
	});
}

export async function deleteAutomation(id: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM automations WHERE id = ?', args: [id] });
}

/** Takes an issue for one task; false when it already has one. */
export async function claimIssue(projectId: string, issueNumber: number, automationId: string): Promise<boolean> {
	const db = await appDb();
	const result = await db.execute({
		sql: 'INSERT OR IGNORE INTO issue_tasks (project_id, issue_number, automation_id, created_at) VALUES (?, ?, ?, ?)',
		args: [projectId, issueNumber, automationId, new Date().toISOString()],
	});
	return result.rowsAffected === 1;
}

/** Gives a claimed issue back, when its task could not start, so a later run tries again. */
export async function releaseIssue(projectId: string, issueNumber: number): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM issue_tasks WHERE project_id = ? AND issue_number = ?', args: [projectId, issueNumber] });
}

export async function setIssueTask(projectId: string, issueNumber: number, sessionId: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'UPDATE issue_tasks SET session_id = ? WHERE project_id = ? AND issue_number = ?', args: [sessionId, projectId, issueNumber] });
}

/** Issues of the repo that already have a task, and the tasks they started. */
export async function issueTasks(projectId: string): Promise<{ issues: Set<number>; sessions: string[] }> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT issue_number, session_id FROM issue_tasks WHERE project_id = ?', args: [projectId] });
	return {
		issues: new Set(result.rows.map((row) => Number(row.issue_number))),
		sessions: result.rows.flatMap((row) => (row.session_id == null ? [] : [String(row.session_id)])),
	};
}
