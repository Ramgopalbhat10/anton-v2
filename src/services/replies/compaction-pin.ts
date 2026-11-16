import { isIncognitoId } from '../../core/incognito.ts';
import { onMainCoder } from '../context/context-usage.ts';
import { requestLines, requestFor } from './finish-review.ts';
import { changeGate, gate } from './gate-state.ts';
import { type Todo, todosFor } from './todos.ts';

/*
 * After a compaction the summary paraphrases the request and drops the todo list, so the next message to the Coder carries
 * both word for word. Flue lets Anton add a message only from its start and finish hooks: it rides on whatever the finish
 * hook sends back (never alone, as that costs a model call over the whole conversation), else the next message's start.
 * Never in the system prompt or a tool's description, which stay byte for byte the same for the prompt cache.
 */

type CompactionEvent = { type?: string; isError?: boolean; instanceId?: string; taskId?: string; session?: string; agentName?: string };

export function noteCompaction(event: CompactionEvent): void {
	if (event.type !== 'compaction' || event.isError || !onMainCoder(event)) return;
	// An incognito chat keeps nothing, so nothing is noted for it; it has neither a request kept nor a list.
	if (isIncognitoId(event.instanceId!)) return;
	changeGate(event.instanceId!, (state) => {
		state.compacted = true;
	});
}

const CUT = '[The request goes on past this point; only its start is repeated here.]';

const item = (todo: Todo, index: number) => `${index + 1}. ${todo.content} (${todo.status}${todo.evidence ? `; evidence: ${todo.evidence}` : ''})`;

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

/** Once per compaction. `request: false` leaves the request out where it already follows the summary word for word. Read after `loadGate`. */
export async function takePinned(id: string, { request = true }: { request?: boolean } = {}): Promise<string | null> {
	if (!gate(id).compacted) return null;
	changeGate(id, (state) => {
		delete state.compacted;
	});
	const list = await todosFor(id).catch(() => null);
	return pinnedMessage(request ? requestFor(id) : undefined, list?.todos);
}
