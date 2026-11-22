import { logProblem } from '../../core/log.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { listTodosForSession, unlinkSessionTodos, updateSpaceTodo } from '../../db/space-todos.ts';

/** Keeps a todo's completion status in sync when any of its linked threads resolves, merges, or reopens. */
export async function syncTodosForThread(sessionId: string): Promise<void> {
	const linked = await listTodosForSession(sessionId);
	if (linked.length === 0) return;
	for (const todo of linked) {
		if (todo.status === 'cancelled' || todo.threadIds.length === 0) continue;
		const records = await Promise.all(todo.threadIds.map((id) => getSessionRecord(id)));
		const live = records.filter((record): record is NonNullable<typeof record> => record !== null);
		if (live.length === 0) continue;
		const allResolved = live.every((record) => Boolean(record.resolvedAt));
		if (allResolved && todo.status !== 'done') {
			await updateSpaceTodo(todo.id, { status: 'done', completedAt: new Date().toISOString() });
		} else if (!allResolved && todo.status === 'done') {
			await updateSpaceTodo(todo.id, { status: 'in_progress', completedAt: null });
		}
	}
}

/** Unlinks a deleted thread; if an in-progress todo has no threads left, returns it to open so work is not lost. */
export async function handleDeletedThread(sessionId: string): Promise<void> {
	try {
		const affected = await unlinkSessionTodos(sessionId);
		for (const todo of affected) {
			const remaining = todo.threadIds.filter((id) => id !== sessionId);
			if (remaining.length === 0 && todo.status === 'in_progress') {
				await updateSpaceTodo(todo.id, { status: 'open', assigneeKind: 'unassigned', assignedAt: null });
			} else if (remaining.length > 0) {
				await syncTodosForThread(remaining[0]);
			}
		}
	} catch (error) {
		logProblem('warn', 'Could not update to-dos after thread deletion', error, sessionId);
	}
}
