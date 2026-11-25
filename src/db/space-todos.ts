import { randomUUID } from 'node:crypto';
import type { RunOn } from '../core/types.ts';
import { announce } from '../core/changes.ts';
import { SPACE_TODO_STATUSES, type SpaceTodo, type SpaceTodoStatus, type TodoAttachment } from '../core/space-todos.ts';
import { appDb } from './client.ts';

type Row = Record<string, unknown>;

/** Counts only threads that still exist; `open_threads` those of them not resolved. */
const SELECT = `SELECT t.*,
	(SELECT COUNT(*) FROM space_todo_threads l INNER JOIN sessions s ON s.id = l.session_id WHERE l.todo_id = t.id) AS threads,
	(SELECT COUNT(*) FROM space_todo_threads l INNER JOIN sessions s ON s.id = l.session_id WHERE l.todo_id = t.id AND s.resolved_at IS NULL) AS open_threads
	FROM space_todos t`;

function attachmentsOf(json: unknown): TodoAttachment[] {
	try {
		const list: unknown = JSON.parse(String(json ?? '[]'));
		if (!Array.isArray(list)) return [];
		return list.flatMap((item: Record<string, unknown>) =>
			item && typeof item.path === 'string' && typeof item.name === 'string' ? [{ name: item.name, path: item.path, kind: String(item.kind ?? ''), size: Number(item.size ?? 0) }] : [],
		);
	} catch {
		return [];
	}
}

function reposOf(json: unknown): string[] {
	try {
		const list: unknown = JSON.parse(String(json ?? '[]'));
		return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

function toTodo(row: Row): SpaceTodo {
	const status = String(row.status);
	const assignee = row.assignee == null ? null : String(row.assignee);
	return {
		id: String(row.id),
		spaceId: String(row.space_id),
		title: String(row.title),
		description: String(row.description ?? ''),
		attachments: attachmentsOf(row.attachments_json),
		threadModel: row.thread_model_json == null ? null : JSON.parse(String(row.thread_model_json)),
		repos: reposOf(row.repos_json),
		runOn: row.run_on === 'host' ? 'host' : 'sandbox',
		status: (SPACE_TODO_STATUSES as readonly string[]).includes(status) ? (status as SpaceTodoStatus) : 'open',
		assignee: assignee === 'coordinator' || assignee === 'thread' ? assignee : null,
		createdBy: row.created_by === 'coordinator' ? 'coordinator' : 'user',
		threads: Number(row.threads ?? 0),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		completedAt: row.completed_at == null ? null : String(row.completed_at),
	};
}

/**
 * A to-do's state follows its threads, read here rather than hooked into every way a thread resolves, reopens or is
 * deleted: one in progress is done once every linked thread is resolved, and back to open when its threads are all gone.
 * A coordinator's to-do with no thread yet stays with it.
 */
function settled(row: Row): Partial<SpaceTodo> | null {
	if (row.status !== 'in_progress') return null;
	const threads = Number(row.threads ?? 0);
	if (threads > 0 && Number(row.open_threads ?? 0) === 0) return { status: 'done', completedAt: new Date().toISOString() };
	if (threads === 0 && row.assignee === 'thread') return { status: 'open', assignee: null };
	return null;
}

export async function listSpaceTodos(spaceId: string): Promise<SpaceTodo[]> {
	const db = await appDb();
	const result = await db.execute({ sql: `${SELECT} WHERE t.space_id = ? ORDER BY t.created_at ASC`, args: [spaceId] });
	const todos: SpaceTodo[] = [];
	for (const row of result.rows as Row[]) {
		const change = settled(row);
		todos.push(change ? ((await updateSpaceTodo(String(row.id), change, { quiet: true })) ?? toTodo(row)) : toTodo(row));
	}
	return todos;
}

export async function getSpaceTodo(id: string): Promise<SpaceTodo | null> {
	const db = await appDb();
	const result = await db.execute({ sql: `${SELECT} WHERE t.id = ?`, args: [id] });
	const row = result.rows[0] as Row | undefined;
	return row ? toTodo(row) : null;
}

const modelJson = (choice: SpaceTodo['threadModel'] | undefined) => choice ? JSON.stringify(choice) : null;

export async function insertSpaceTodo(input: { spaceId: string; title: string; description: string; attachments?: TodoAttachment[]; threadModel?: SpaceTodo['threadModel']; repos?: string[]; runOn?: RunOn; createdBy: SpaceTodo['createdBy'] }): Promise<SpaceTodo> {
	const db = await appDb();
	const id = `todo_${randomUUID()}`;
	const now = new Date().toISOString();
	await db.execute({
		sql: 'INSERT INTO space_todos (id, space_id, title, description, attachments_json, thread_model_json, repos_json, run_on, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
		args: [id, input.spaceId, input.title, input.description, JSON.stringify(input.attachments ?? []), modelJson(input.threadModel), JSON.stringify(input.repos ?? []), input.runOn === 'host' ? 'host' : null, input.createdBy, now, now],
	});
	announce({ kind: 'space', id: input.spaceId, what: 'todos' });
	return (await getSpaceTodo(id))!;
}

const COLUMNS = { title: 'title', description: 'description', attachments: 'attachments_json', threadModel: 'thread_model_json', repos: 'repos_json', runOn: 'run_on', status: 'status', assignee: 'assignee', completedAt: 'completed_at' } as const;

export type SpaceTodoUpdate = Partial<Pick<SpaceTodo, keyof typeof COLUMNS>>;

/** `quiet` while a read settles it: the read already returns the new state. */
export async function updateSpaceTodo(id: string, update: SpaceTodoUpdate, { quiet = false } = {}): Promise<SpaceTodo | null> {
	const entries = Object.entries(COLUMNS).filter(([key]) => key in update);
	const db = await appDb();
	await db.execute({
		sql: `UPDATE space_todos SET ${entries.map(([, column]) => `${column} = ?, `).join('')}updated_at = ? WHERE id = ?`,
		args: [...entries.map(([key]) => {
			if (key === 'attachments') return JSON.stringify(update.attachments ?? []);
			if (key === 'threadModel') return modelJson(update.threadModel);
			if (key === 'repos') return JSON.stringify(update.repos ?? []);
			if (key === 'runOn') return update.runOn === 'host' ? 'host' : null;
			return update[key as Exclude<keyof SpaceTodoUpdate, 'attachments' | 'threadModel' | 'repos' | 'runOn'>] ?? null;
		}), new Date().toISOString(), id],
	});
	const todo = await getSpaceTodo(id);
	if (todo && !quiet) announce({ kind: 'space', id: todo.spaceId, what: 'todos' });
	return todo;
}

export async function deleteSpaceTodoRecord(todo: SpaceTodo): Promise<void> {
	const db = await appDb();
	await db.batch(
		[
			{ sql: 'DELETE FROM space_todo_handoffs WHERE todo_id = ?', args: [todo.id] },
			{ sql: 'DELETE FROM space_todo_threads WHERE todo_id = ?', args: [todo.id] },
			{ sql: 'DELETE FROM space_todos WHERE id = ?', args: [todo.id] },
		],
		'write',
	);
	announce({ kind: 'space', id: todo.spaceId, what: 'todos' });
}

/** The to-do a thread was started or messaged for, the earliest if several. */
export async function todoIdOfThread(sessionId: string): Promise<string | null> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT todo_id FROM space_todo_threads WHERE session_id = ? ORDER BY linked_at LIMIT 1', args: [sessionId] });
	return result.rows[0] ? String(result.rows[0].todo_id) : null;
}

export async function linkTodoThreadRecord(todoId: string, sessionId: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'INSERT OR IGNORE INTO space_todo_threads (todo_id, session_id, linked_at) VALUES (?, ?, ?)', args: [todoId, sessionId, new Date().toISOString()] });
}

/** One-time server-issued authorization for a board handoff to the coordinator. */
export async function insertTodoHandoffGrant(input: { id: string; spaceId: string; todoId: string; runOn: RunOn; bodyHash: string }): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: 'INSERT INTO space_todo_handoffs (id, space_id, todo_id, run_on, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
		args: [input.id, input.spaceId, input.todoId, input.runOn, input.bodyHash, new Date().toISOString()],
	});
}

/** Atomically claims a pending board handoff grant matching this space, to-do and exact delivered body. */
export async function claimTodoHandoffGrant(spaceId: string, todoId: string, bodyHash: string): Promise<{ id: string; todoId: string; runOn: RunOn } | null> {
	const db = await appDb();
	const found = await db.execute({
		sql: 'SELECT id, todo_id, run_on FROM space_todo_handoffs WHERE space_id = ? AND todo_id = ? AND body_hash = ? AND claimed_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
		args: [spaceId, todoId, bodyHash],
	});
	const row = found.rows[0] as Row | undefined;
	if (!row) return null;
	const id = String(row.id);
	const updated = await db.execute({
		sql: 'UPDATE space_todo_handoffs SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL',
		args: [new Date().toISOString(), id],
	});
	if (!updated.rowsAffected) return null;
	return { id, todoId: String(row.todo_id), runOn: row.run_on === 'host' ? 'host' : 'sandbox' };
}

export async function hasValidTodoHostGrant(spaceId: string, todoId: string, grantId: string): Promise<boolean> {
	const db = await appDb();
	const result = await db.execute({
		sql: "SELECT 1 FROM space_todo_handoffs WHERE id = ? AND space_id = ? AND todo_id = ? AND run_on = 'host' AND claimed_at IS NOT NULL AND revoked_at IS NULL LIMIT 1",
		args: [grantId, spaceId, todoId],
	});
	return result.rows.length > 0;
}

export async function revokeTodoHandoffGrants(todoId: string): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: 'UPDATE space_todo_handoffs SET revoked_at = ? WHERE todo_id = ? AND revoked_at IS NULL',
		args: [new Date().toISOString(), todoId],
	});
}

export async function revokeHandoffGrantsByIds(grantIds: string[]): Promise<void> {
	if (!grantIds.length) return;
	const db = await appDb();
	const now = new Date().toISOString();
	await db.batch(
		grantIds.map((id) => ({ sql: 'UPDATE space_todo_handoffs SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', args: [now, id] })),
		'write',
	);
}

/** Revokes grants already claimed by earlier replies in this project without touching pending handoffs not yet delivered. */
export async function revokeSpaceClaimedHandoffGrants(spaceId: string): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: 'UPDATE space_todo_handoffs SET revoked_at = ? WHERE space_id = ? AND claimed_at IS NOT NULL AND revoked_at IS NULL',
		args: [new Date().toISOString(), spaceId],
	});
}
