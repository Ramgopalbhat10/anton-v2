import { isIncognitoId } from '../core/incognito.ts';
import { onMainCoder } from './context-usage.ts';
import { requestLines, requestFor } from './finish-review.ts';
import { changeGate, gate } from './gate-state.ts';
import { type Todo, todosFor } from './todos.ts';

/*
 * The request and the todo list, word for word, after a compaction. A compaction folds the conversation's older turns
 * into a summary, and a summary paraphrases: the request's exact words (the names, flags, messages and edge cases the
 * checks at a reply's end hold the agent to) became the summary's, and the todo list, which the agent sees only through
 * its own earlier `update_todos` calls, went with them, though the agent changes its items by number. So once a
 * compaction of the Coder's main conversation has happened, the next message the Coder gets carries both as they are
 * kept: the request (`requestFor`) and the saved list numbered from 1, as `changes` counts it.
 *
 * Flue lets Anton add a message to a running reply only from its start and finish hooks. Flue compacts at a would-stop
 * point (the model ended a step with no tool call) or when a call overflows the window, so the next of those is the
 * finish hook that runs after the compaction, or, when that hook lets the reply end, the start of the next message.
 * The pinned message goes with whatever the finish hook sends the reply back with, never on its own, since a reply sent
 * back for it alone would cost a model call over the whole conversation to say it was done; and at the next message's
 * start otherwise. It is never in the system prompt or a tool's description, which stay byte for byte the same through
 * a task for the prompt cache.
 */

/** The runtime's `compaction` event, as much of it as is read here. */
type CompactionEvent = { type?: string; isError?: boolean; instanceId?: string; taskId?: string; session?: string; agentName?: string };

/** Notes a finished compaction of a task's main Coder conversation, from the runtime's `compaction` event. */
export function noteCompaction(event: CompactionEvent): void {
	if (event.type !== 'compaction' || event.isError || !onMainCoder(event)) return;
	// An incognito chat keeps nothing, so nothing is noted for it; it has neither a request kept nor a list.
	if (isIncognitoId(event.instanceId!)) return;
	changeGate(event.instanceId!, (state) => {
		state.compacted = true;
	});
}

/** What a request past `MAX_SELF_REQUEST` is followed by: the rest is no longer in the conversation. */
const CUT = '[The request goes on past this point; only its start is repeated here.]';

const item = (todo: Todo, index: number) => `${index + 1}. ${todo.content} (${todo.status}${todo.evidence ? `; evidence: ${todo.evidence}` : ''})`;

/** The message itself: the request and the list as kept, or null when there is neither. */
export function pinnedMessage(request: string | undefined, todos: readonly Todo[] | undefined): string | null {
	const parts: string[] = [];
	if (request?.trim()) parts.push(['The request you are working on:', ...requestLines(request, CUT)].join('\n'));
	if (todos?.length) parts.push(['Your todo list as saved, numbered as update_todos counts items in changes:', ...todos.map(item)].join('\n'));
	if (!parts.length) return null;
	return [
		'The conversation was just compacted: its older turns are now a summary. What follows is not summarized but exact, as it is kept.',
		...parts,
		'Go on from where the summary says you were.',
	].join('\n\n');
}

/**
 * The message due after a compaction, once: null when none happened since the last, or when the task has neither a
 * request nor a list. `request: false` leaves the request out where it already sits word for word after the summary
 * (a reply started by a message, which is the request). Read after the task's checks' state (`loadGate`).
 */
export async function takePinned(id: string, { request = true }: { request?: boolean } = {}): Promise<string | null> {
	if (!gate(id).compacted) return null;
	changeGate(id, (state) => {
		delete state.compacted;
	});
	const list = await todosFor(id).catch(() => null);
	return pinnedMessage(request ? requestFor(id) : undefined, list?.todos);
}
