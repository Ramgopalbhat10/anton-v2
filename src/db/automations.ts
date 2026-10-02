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
	enabled: boolean;
	lastRunAt: string | null;
	lastError: string | null;
	/** Issue numbers that already have a task. */
	seen: number[];
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
		enabled: Number(row.enabled) === 1,
		lastRunAt: optional(row.last_run_at),
		lastError: optional(row.last_error),
		seen: row.seen_json == null ? [] : (JSON.parse(String(row.seen_json)) as number[]),
		createdAt: String(row.created_at),
	};
}

export type NewAutomation = Pick<Automation, 'projectId' | 'kind' | 'label' | 'everyHours' | 'prompt' | 'model' | 'reasoning'>;

export async function insertAutomation(input: NewAutomation): Promise<Automation> {
	const db = await appDb();
	const id = `auto_${randomUUID()}`;
	await db.execute({
		sql: `INSERT INTO automations (id, project_id, kind, label, every_hours, prompt, model, reasoning, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
		args: [id, input.projectId, input.kind, input.label, input.everyHours, input.prompt, input.model, input.reasoning, new Date().toISOString()],
	});
	return (await getAutomation(id))!;
}

export async function listAutomations(projectId?: string): Promise<Automation[]> {
	const db = await appDb();
	const result = projectId
		? await db.execute({ sql: 'SELECT * FROM automations WHERE project_id = ? ORDER BY created_at', args: [projectId] })
		: await db.execute('SELECT * FROM automations ORDER BY created_at');
	return result.rows.map((row) => toAutomation(row as Row));
}

export async function getAutomation(id: string): Promise<Automation | null> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT * FROM automations WHERE id = ?', args: [id] });
	return result.rows[0] ? toAutomation(result.rows[0] as Row) : null;
}

const columns = { enabled: 'enabled', lastRunAt: 'last_run_at', lastError: 'last_error', seen: 'seen_json' } as const;
export type AutomationUpdate = Partial<Pick<Automation, keyof typeof columns>>;

const stored = (key: keyof typeof columns, value: unknown) =>
	key === 'enabled' ? (value ? 1 : 0) : key === 'seen' ? JSON.stringify(value) : ((value as string | null) ?? null);

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
