import { randomUUID } from 'node:crypto';
import type { Reasoning } from '../core/ports.ts';
import { announce } from '../core/changes.ts';
import {
	SPACE_TODO_STATUSES,
	TODO_PRIORITIES,
	type SpaceTodo,
	type SpaceTodoAssignee,
	type SpaceTodoCreator,
	type SpaceTodoStatus,
	type TodoPriority,
} from '../core/space-todos.ts';
import { appDb } from './client.ts';

type Row = Record<string, unknown>;
const optional = (value: unknown) => (value == null ? null : String(value));

function parseStringArray(value: unknown): string[] {
	try {
		const parsed = JSON.parse(String(value ?? '[]'));
		return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
	} catch {
		return [];
	}
}

function asStatus(value: unknown): SpaceTodoStatus {
	const text = String(value ?? 'open');
	return (SPACE_TODO_STATUSES as readonly string[]).includes(text) ? (text as SpaceTodoStatus) : 'open';
}

function asPriority(value: unknown): TodoPriority | null {
	if (value == null) return null;
	const text = String(value);
	return (TODO_PRIORITIES as readonly string[]).includes(text) ? (text as TodoPriority) : null;
}

function asAssignee(value: unknown): SpaceTodoAssignee {
	const text = String(value ?? 'unassigned');
	return text === 'coordinator' || text === 'thread' ? text : 'unassigned';
}

function asCreator(value: unknown): SpaceTodoCreator {
	const text = String(value ?? 'user');
	return text === 'coordinator' || text === 'routine' ? text : 'user';
}

function toTodo(row: Row, threadIds: string[]): SpaceTodo {
	return {
		id: String(row.id),
		spaceId: String(row.space_id),
		title: String(row.title),
		description: String(row.description ?? ''),
		status: asStatus(row.status),
		assigneeKind: asAssignee(row.assignee_kind),
		priority: asPriority(row.priority),
		tags: parseStringArray(row.tags_json),
		projectId: optional(row.project_id),
		model: optional(row.model),
		reasoning: optional(row.reasoning) as Reasoning | null,
		planMode: Number(row.plan_mode ?? 0) === 1,
		files: parseStringArray(row.files_json),
		dueAt: optional(row.due_at),
		sourceUrl: optional(row.source_url),
		position: Number(row.position ?? 0),
		createdBy: asCreator(row.created_by),
		threadIds,
		assignedAt: optional(row.assigned_at),
		completedAt: optional(row.completed_at),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

async function threadIdsByTodo(spaceId?: string): Promise<Map<string, string[]>> {
	const db = await appDb();
	const result = spaceId
		? await db.execute({
				sql: 'SELECT l.todo_id, l.session_id FROM space_todo_threads l INNER JOIN space_todos t ON t.id = l.todo_id WHERE t.space_id = ? ORDER BY l.linked_at ASC',
				args: [spaceId],
			})
		: await db.execute('SELECT todo_id, session_id FROM space_todo_threads ORDER BY linked_at ASC');
	const map = new Map<string, string[]>();
	for (const row of result.rows) {
		const todoId = String(row.todo_id);
		map.set(todoId, [...(map.get(todoId) ?? []), String(row.session_id)]);
	}
	return map;
}

export async function listSpaceTodos(spaceId: string): Promise<SpaceTodo[]> {
	const db = await appDb();
	const [result, links] = await Promise.all([
		db.execute({ sql: 'SELECT * FROM space_todos WHERE space_id = ? ORDER BY position ASC, created_at DESC', args: [spaceId] }),
		threadIdsByTodo(spaceId),
	]);
	return result.rows.map((row) => toTodo(row as Row, links.get(String(row.id)) ?? []));
}

export async function getSpaceTodo(id: string): Promise<SpaceTodo | null> {
	const db = await appDb();
	const [result, links] = await Promise.all([
		db.execute({ sql: 'SELECT * FROM space_todos WHERE id = ?', args: [id] }),
		db.execute({ sql: 'SELECT session_id FROM space_todo_threads WHERE todo_id = ? ORDER BY linked_at ASC', args: [id] }),
	]);
	if (!result.rows[0]) return null;
	return toTodo(
		result.rows[0] as Row,
		links.rows.map((row) => String(row.session_id)),
	);
}

export async function listTodosForSession(sessionId: string): Promise<SpaceTodo[]> {
	const db = await appDb();
	const result = await db.execute({
		sql: 'SELECT t.* FROM space_todos t INNER JOIN space_todo_threads l ON l.todo_id = t.id WHERE l.session_id = ? ORDER BY t.position ASC, t.created_at DESC',
		args: [sessionId],
	});
	if (result.rows.length === 0) return [];
	const links = await Promise.all(
		result.rows.map((row) =>
			db.execute({ sql: 'SELECT session_id FROM space_todo_threads WHERE todo_id = ? ORDER BY linked_at ASC', args: [String(row.id)] }),
		),
	);
	return result.rows.map((row, index) =>
		toTodo(
			row as Row,
			links[index].rows.map((link) => String(link.session_id)),
		),
	);
}

export type NewSpaceTodo = {
	spaceId: string;
	title: string;
	description?: string;
	priority?: TodoPriority | null;
	tags?: string[];
	projectId?: string | null;
	model?: string | null;
	reasoning?: Reasoning | null;
	planMode?: boolean;
	files?: string[];
	dueAt?: string | null;
	sourceUrl?: string | null;
	createdBy?: SpaceTodoCreator;
};

export async function insertSpaceTodo(input: NewSpaceTodo): Promise<SpaceTodo> {
	const db = await appDb();
	const id = `todo_${randomUUID()}`;
	const now = new Date().toISOString();
	const maxPos = await db.execute({ sql: 'SELECT COALESCE(MAX(position), -1) AS max_pos FROM space_todos WHERE space_id = ?', args: [input.spaceId] });
	const position = Number(maxPos.rows[0]?.max_pos ?? -1) + 1;
	await db.execute({
		sql: `INSERT INTO space_todos (id, space_id, title, description, status, assignee_kind, priority, tags_json, project_id, model, reasoning, plan_mode, files_json, due_at, source_url, position, created_by, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'open', 'unassigned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			id,
			input.spaceId,
			input.title,
			input.description ?? '',
			input.priority ?? null,
			JSON.stringify(input.tags ?? []),
			input.projectId ?? null,
			input.model ?? null,
			input.reasoning ?? null,
			input.planMode ? 1 : 0,
			JSON.stringify(input.files ?? []),
			input.dueAt ?? null,
			input.sourceUrl ?? null,
			position,
			input.createdBy ?? 'user',
			now,
			now,
		],
	});
	announce({ kind: 'space', id: input.spaceId, what: 'todos' });
	return (await getSpaceTodo(id))!;
}

const COLUMNS = {
	title: 'title',
	description: 'description',
	status: 'status',
	assigneeKind: 'assignee_kind',
	priority: 'priority',
	tags: 'tags_json',
	projectId: 'project_id',
	model: 'model',
	reasoning: 'reasoning',
	planMode: 'plan_mode',
	files: 'files_json',
	dueAt: 'due_at',
	sourceUrl: 'source_url',
	position: 'position',
	assignedAt: 'assigned_at',
	completedAt: 'completed_at',
} as const;

export type SpaceTodoUpdate = Partial<{
	title: string;
	description: string;
	status: SpaceTodoStatus;
	assigneeKind: SpaceTodoAssignee;
	priority: TodoPriority | null;
	tags: string[];
	projectId: string | null;
	model: string | null;
	reasoning: Reasoning | null;
	planMode: boolean;
	files: string[];
	dueAt: string | null;
	sourceUrl: string | null;
	position: number;
	assignedAt: string | null;
	completedAt: string | null;
}>;

export async function updateSpaceTodo(id: string, update: SpaceTodoUpdate): Promise<SpaceTodo | null> {
	const existing = await getSpaceTodo(id);
	if (!existing) return null;
	const entries = Object.entries(COLUMNS).filter(([key]) => key in update);
	if (entries.length === 0) return existing;
	const db = await appDb();
	await db.execute({
		sql: `UPDATE space_todos SET ${entries.map(([, col]) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
		args: [
			...entries.map(([key]) => {
				const value = update[key as keyof SpaceTodoUpdate];
				if (value == null) return null;
				if (typeof value === 'boolean') return value ? 1 : 0;
				if (typeof value === 'object') return JSON.stringify(value);
				return value;
			}),
			new Date().toISOString(),
			id,
		],
	});
	announce({ kind: 'space', id: existing.spaceId, what: 'todos' });
	return getSpaceTodo(id);
}

export async function deleteSpaceTodoRecord(id: string): Promise<boolean> {
	const existing = await getSpaceTodo(id);
	if (!existing) return false;
	const db = await appDb();
	await db.batch(
		[
			{ sql: 'DELETE FROM space_todo_threads WHERE todo_id = ?', args: [id] },
			{ sql: 'DELETE FROM space_todos WHERE id = ?', args: [id] },
		],
		'write',
	);
	announce({ kind: 'space', id: existing.spaceId, what: 'todos' });
	return true;
}

export async function reorderSpaceTodoRecords(spaceId: string, orderedIds: string[]): Promise<void> {
	if (orderedIds.length === 0) return;
	const db = await appDb();
	const now = new Date().toISOString();
	await db.batch(
		orderedIds.map((id, position) => ({
			sql: 'UPDATE space_todos SET position = ?, updated_at = ? WHERE id = ? AND space_id = ?',
			args: [position, now, id, spaceId],
		})),
		'write',
	);
	announce({ kind: 'space', id: spaceId, what: 'todos' });
}

export async function linkTodoThreadRecord(todoId: string, sessionId: string): Promise<void> {
	const existing = await getSpaceTodo(todoId);
	if (!existing) return;
	const db = await appDb();
	await db.execute({
		sql: 'INSERT OR IGNORE INTO space_todo_threads (todo_id, session_id, linked_at) VALUES (?, ?, ?)',
		args: [todoId, sessionId, new Date().toISOString()],
	});
	announce({ kind: 'space', id: existing.spaceId, what: 'todos' });
}

export async function unlinkSessionTodos(sessionId: string): Promise<SpaceTodo[]> {
	const linked = await listTodosForSession(sessionId);
	if (linked.length === 0) return [];
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM space_todo_threads WHERE session_id = ?', args: [sessionId] });
	const spaces = new Set(linked.map((todo) => todo.spaceId));
	for (const spaceId of spaces) announce({ kind: 'space', id: spaceId, what: 'todos' });
	return linked;
}
