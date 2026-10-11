import { randomUUID } from 'node:crypto';
import type { Reasoning } from '../core/ports.ts';
import { announce } from '../core/changes.ts';
import { appDb } from './client.ts';

/** How a project's coordinator treats new work: starts threads itself, or proposes them for you to start. */
export type Autonomy = 'start' | 'propose';
/** A paused project starts no threads; an archived one is put away. Both keep their threads. */
export type SpaceState = 'active' | 'paused' | 'archived';

/**
 * A project, called a space in code because `projects` already means a
 * repository: a coordinator conversation that hands work to parallel
 * threads, each an ordinary task on one of the project's repositories.
 */
export type Space = {
	id: string;
	name: string;
	/** One emoji or short mark shown with the name; null shows its initial. */
	icon: string | null;
	/** One line on what the project is for. */
	goal: string;
	/** Sent to every thread and the coordinator. */
	instructions: string;
	/** Notes the coordinator and threads save as they learn: decisions, preferences, pitfalls. */
	memory: string;
	/** The coordinator's model; null uses a small default. */
	coordinatorModel: string | null;
	coordinatorReasoning: Reasoning | null;
	/** New threads' model; null uses Settings › General. */
	threadModel: string | null;
	threadReasoning: Reasoning | null;
	/** Threads working at once; more wait as queued. */
	maxParallel: number;
	autonomy: Autonomy;
	state: SpaceState;
	/** Repository (`projects`) ids, in the order they were added. */
	repoIds: string[];
	createdAt: string;
	updatedAt: string;
};

type Row = Record<string, unknown>;
const optional = (value: unknown) => (value == null ? null : String(value));

function toSpace(row: Row, repoIds: string[]): Space {
	return {
		id: String(row.id),
		name: String(row.name),
		icon: optional(row.icon),
		goal: String(row.goal ?? ''),
		instructions: String(row.instructions ?? ''),
		memory: String(row.memory ?? ''),
		coordinatorModel: optional(row.coordinator_model),
		coordinatorReasoning: optional(row.coordinator_reasoning) as Reasoning | null,
		threadModel: optional(row.thread_model),
		threadReasoning: optional(row.thread_reasoning) as Reasoning | null,
		maxParallel: Number(row.max_parallel ?? 3),
		autonomy: row.autonomy === 'propose' ? 'propose' : 'start',
		state: (['paused', 'archived'].includes(String(row.state)) ? String(row.state) : 'active') as SpaceState,
		repoIds,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

async function reposBySpace(): Promise<Map<string, string[]>> {
	const db = await appDb();
	const result = await db.execute('SELECT space_id, project_id FROM space_repos ORDER BY position');
	const repos = new Map<string, string[]>();
	for (const row of result.rows) repos.set(String(row.space_id), [...(repos.get(String(row.space_id)) ?? []), String(row.project_id)]);
	return repos;
}

export async function listSpaces(): Promise<Space[]> {
	const db = await appDb();
	const [result, repos] = await Promise.all([db.execute('SELECT * FROM spaces ORDER BY updated_at DESC'), reposBySpace()]);
	return result.rows.map((row) => toSpace(row as Row, repos.get(String(row.id)) ?? []));
}

export async function getSpace(id: string): Promise<Space | null> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT * FROM spaces WHERE id = ?', args: [id] });
	if (!result.rows[0]) return null;
	const repos = await db.execute({ sql: 'SELECT project_id FROM space_repos WHERE space_id = ? ORDER BY position', args: [id] });
	return toSpace(result.rows[0] as Row, repos.rows.map((row) => String(row.project_id)));
}

export type NewSpace = Pick<Space, 'name' | 'icon' | 'goal'> & Partial<Pick<Space, 'instructions' | 'autonomy' | 'maxParallel'>>;

export async function insertSpace(input: NewSpace): Promise<string> {
	const db = await appDb();
	const id = `space_${randomUUID()}`;
	const now = new Date().toISOString();
	await db.execute({
		sql: `INSERT INTO spaces (id, name, icon, goal, instructions, autonomy, max_parallel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [id, input.name, input.icon, input.goal, input.instructions ?? '', input.autonomy ?? 'start', input.maxParallel ?? 3, now, now],
	});
	announce({ kind: 'spaces' });
	return id;
}

const columns = {
	name: 'name',
	icon: 'icon',
	goal: 'goal',
	instructions: 'instructions',
	memory: 'memory',
	coordinatorModel: 'coordinator_model',
	coordinatorReasoning: 'coordinator_reasoning',
	threadModel: 'thread_model',
	threadReasoning: 'thread_reasoning',
	maxParallel: 'max_parallel',
	autonomy: 'autonomy',
	state: 'state',
} as const;

export type SpaceUpdate = Partial<Pick<Space, keyof typeof columns>>;

export async function updateSpace(id: string, update: SpaceUpdate): Promise<void> {
	const entries = Object.entries(columns).filter(([key]) => key in update);
	if (entries.length === 0) return;
	const db = await appDb();
	await db.execute({
		sql: `UPDATE spaces SET ${entries.map(([, column]) => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
		args: [...entries.map(([key]) => (update[key as keyof SpaceUpdate] ?? null) as string | number | null), new Date().toISOString(), id],
	});
	announce({ kind: 'spaces' });
	announce({ kind: 'space', id, what: 'settings' });
}

/** Marks the project as just used, so it lists first. */
export async function touchSpace(id: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'UPDATE spaces SET updated_at = ? WHERE id = ?', args: [new Date().toISOString(), id] });
}

/** Sets the project's repositories, in this order. */
export async function setSpaceRepos(id: string, projectIds: string[]): Promise<void> {
	const db = await appDb();
	await db.batch(
		[
			{ sql: 'DELETE FROM space_repos WHERE space_id = ?', args: [id] },
			...projectIds.map((projectId, position) => ({ sql: 'INSERT INTO space_repos (space_id, project_id, position) VALUES (?, ?, ?)', args: [id, projectId, position] })),
		],
		'write',
	);
	announce({ kind: 'spaces' });
	announce({ kind: 'space', id, what: 'settings' });
}

/** Adds one line to the project's memory while it stays under `maxLength`; false when it is full. */
export async function appendSpaceMemory(id: string, line: string, maxLength: number): Promise<boolean> {
	const db = await appDb();
	const result = await db.execute({
		sql: `UPDATE spaces SET memory = CASE WHEN memory = '' THEN ? ELSE memory || char(10) || ? END
			WHERE id = ? AND length(memory) + length(?) + 1 <= ?`,
		args: [line, line, id, line, maxLength],
	});
	if (result.rowsAffected === 1) announce({ kind: 'space', id, what: 'settings' });
	return result.rowsAffected === 1;
}

/** Removes the project; its threads stay as tasks of their own, with their branches and pull requests. */
export async function deleteSpaceRecord(id: string): Promise<void> {
	const db = await appDb();
	await db.batch(
		[
			{ sql: 'UPDATE sessions SET space_id = NULL, brief = NULL WHERE space_id = ?', args: [id] },
			{ sql: 'UPDATE automations SET space_id = NULL WHERE space_id = ?', args: [id] },
			{ sql: 'DELETE FROM space_repos WHERE space_id = ?', args: [id] },
			{ sql: 'DELETE FROM spaces WHERE id = ?', args: [id] },
		],
		'write',
	);
	announce({ kind: 'spaces' });
	announce({ kind: 'sessions' });
}

/** Dollars and tokens the project has spent since `since`, by thread (the coordinator under the project's own id) and by model. */
export async function spaceSpend(id: string, since: Date): Promise<{ byThread: Array<{ key: string; tokens: number; cost: number }>; byModel: Array<{ key: string | null; tokens: number; cost: number }>; daily: Array<{ day: string; cost: number }> }> {
	const db = await appDb();
	const args = [id, since.toISOString()];
	const [threads, models, days] = await Promise.all([
		db.execute({ sql: 'SELECT session_id AS key, SUM(input_tokens + output_tokens) AS tokens, SUM(cost_usd) AS cost FROM usage_log WHERE space_id = ? AND at >= ? GROUP BY 1 ORDER BY cost DESC', args }),
		db.execute({ sql: 'SELECT model AS key, SUM(input_tokens + output_tokens) AS tokens, SUM(cost_usd) AS cost FROM usage_log WHERE space_id = ? AND at >= ? GROUP BY 1 ORDER BY cost DESC', args }),
		db.execute({ sql: 'SELECT substr(at, 1, 10) AS day, SUM(cost_usd) AS cost FROM usage_log WHERE space_id = ? AND at >= ? GROUP BY 1 ORDER BY 1', args }),
	]);
	const row = (r: Row) => ({ tokens: Number(r.tokens ?? 0), cost: Number(r.cost ?? 0) });
	return {
		byThread: threads.rows.map((r) => ({ key: String(r.key), ...row(r as Row) })),
		byModel: models.rows.map((r) => ({ key: r.key == null ? null : String(r.key), ...row(r as Row) })),
		daily: days.rows.map((r) => ({ day: String(r.day), cost: Number(r.cost ?? 0) })),
	};
}
