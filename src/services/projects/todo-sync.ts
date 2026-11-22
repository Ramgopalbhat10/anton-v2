import { logProblem } from '../../core/log.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { listTodosForSession, restoreUnhandledTriaging, unlinkSessionTodos, updateSpaceTodo } from '../../db/space-todos.ts';

/** Auto-completes in-progress to-dos once every linked thread is resolved. Never overrides manual Open or Cancelled changes. */
export async function onThreadResolved(sessionId: string): Promise<void> {
	const linked = await listTodosForSession(sessionId);
	if (linked.length === 0) return;
	for (const todo of linked) {
		if (todo.status !== 'in_progress' || todo.threadIds.length === 0) continue;
		const records = await Promise.all(todo.threadIds.map((id) => getSessionRecord(id)));
		const live = records.filter((record): record is NonNullable<typeof record> => record !== null);
		if (live.length === 0) continue;
		if (live.every((record) => Boolean(record.resolvedAt))) {
			await updateSpaceTodo(todo.id, { status: 'done', completedAt: new Date().toISOString(), completedBy: 'auto' });
		}
	}
}

/** Reopens only to-dos that were automatically completed when a previously resolved linked thread reopens. */
export async function onThreadReopened(sessionId: string): Promise<void> {
	const linked = await listTodosForSession(sessionId);
	if (linked.length === 0) return;
	for (const todo of linked) {
		if (todo.status !== 'done' || todo.completedBy !== 'auto') continue;
		await updateSpaceTodo(todo.id, { status: 'in_progress', completedAt: null, completedBy: null });
	}
}

/** Unlinks a thread that was deleted or moved out of its project; reopens unfinished to-dos that lose their last link. */
export async function unlinkThreadFromTodos(sessionId: string): Promise<void> {
	try {
		const affected = await unlinkSessionTodos(sessionId);
		for (const todo of affected) {
			const remaining = todo.threadIds.filter((id) => id !== sessionId);
			if (remaining.length === 0 && todo.status === 'in_progress') {
				await updateSpaceTodo(todo.id, { status: 'open', assigneeKind: 'unassigned', assignedAt: null, completedAt: null, completedBy: null });
			} else if (remaining.length > 0 && todo.status === 'in_progress') {
				await onThreadResolved(remaining[0]);
			}
		}
	} catch (error) {
		logProblem('warn', 'Could not update to-dos after thread unlink', error, sessionId);
	}
}

type CoordinatorSettledEvent = { type: string; instanceId?: string; agentName?: string; outcome?: string };

/** If a coordinator reply fails or is aborted before linking any thread, return unhandled triaging items to open so they are not stranded. */
export function reconcileCoordinatorSettlement(event: CoordinatorSettledEvent): void {
	if (event.type !== 'submission_settled' || (event.outcome !== 'failed' && event.outcome !== 'aborted')) return;
	if (!event.instanceId) return;
	if (event.agentName && !/^coordinator$/i.test(event.agentName)) return;
	if (!event.agentName && !event.instanceId.startsWith('space_')) return;
	void restoreUnhandledTriaging(event.instanceId).catch((error: unknown) =>
		logProblem('warn', 'Could not restore unhandled triaging to-dos after coordinator settlement', error, event.instanceId),
	);
}
