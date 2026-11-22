import { logProblem } from '../../core/log.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import {
	listTodosForSession,
	markTriagingSettledForSubmission,
	restoreTriagingForSubmission,
	setSpaceTodoAttemptSubmission,
	unlinkSessionTodos,
	updateSpaceTodo,
} from '../../db/space-todos.ts';

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

/** Reconciles a linked thread's current state immediately after a link is saved (handles threads resolved before linking). */
export async function reconcileLinkedThreadState(sessionId: string): Promise<void> {
	const record = await getSessionRecord(sessionId);
	if (record?.resolvedAt) await onThreadResolved(sessionId);
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
				await updateSpaceTodo(todo.id, {
					status: 'open',
					assigneeKind: 'unassigned',
					assignedAt: null,
					completedAt: null,
					completedBy: null,
					attemptId: null,
					attemptSubmissionId: null,
					attemptSettledAt: null,
					attemptLinked: false,
				});
			} else if (remaining.length > 0 && todo.status === 'in_progress') {
				await onThreadResolved(remaining[0]);
			}
		}
	} catch (error) {
		logProblem('warn', 'Could not update to-dos after thread unlink', error, sessionId);
	}
}

type CoordinatorSettledEvent = { type: string; instanceId?: string; agentName?: string; submissionId?: string; outcome?: string };
type SettlementOutcome = 'completed' | 'failed' | 'aborted';

/** Bounded memory of recently settled coordinator submissions in case settlement fires before the receipt id is persisted. */
const MAX_TRACKED_SETTLEMENTS = 200;
const settledOutcomes = new Map<string, SettlementOutcome>();

function rememberSettlement(submissionId: string, outcome: SettlementOutcome): void {
	settledOutcomes.set(submissionId, outcome);
	if (settledOutcomes.size > MAX_TRACKED_SETTLEMENTS) {
		const oldest = settledOutcomes.keys().next().value;
		if (oldest) settledOutcomes.delete(oldest);
	}
}

async function applyCoordinatorSettlement(spaceId: string, submissionId: string, outcome: SettlementOutcome): Promise<void> {
	if (outcome === 'failed' || outcome === 'aborted') {
		await restoreTriagingForSubmission(spaceId, submissionId);
	} else {
		await markTriagingSettledForSubmission(spaceId, submissionId);
	}
}

/** Persists the dispatch submissionId for a coordinator assignment attempt and applies any already-observed settlement. */
export async function recordTodoAttemptSubmission(spaceId: string, todoId: string, attemptId: string, submissionId: string): Promise<void> {
	const saved = await setSpaceTodoAttemptSubmission(todoId, spaceId, attemptId, submissionId);
	if (!saved) return;
	const outcome = settledOutcomes.get(submissionId);
	if (outcome) await applyCoordinatorSettlement(spaceId, submissionId, outcome);
}

/**
 * Tracks coordinator submission settlement by submissionId:
 * - failed/aborted: restores only that submission's unhandled triaging attempt to open.
 * - completed: marks that submission's unhandled triaging attempt as settled so explicit Retry becomes available.
 */
export function reconcileCoordinatorSettlement(event: CoordinatorSettledEvent): void {
	if (event.type !== 'submission_settled' || !event.instanceId || !event.submissionId) return;
	if (event.agentName && !/^coordinator$/i.test(event.agentName)) return;
	if (!event.agentName && !event.instanceId.startsWith('space_')) return;
	const outcome: SettlementOutcome = event.outcome === 'failed' || event.outcome === 'aborted' ? event.outcome : 'completed';
	rememberSettlement(event.submissionId, outcome);
	void applyCoordinatorSettlement(event.instanceId, event.submissionId, outcome).catch((error: unknown) =>
		logProblem('warn', 'Could not reconcile triaging to-do after coordinator settlement', error, event.instanceId),
	);
}
