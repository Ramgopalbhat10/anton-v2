import * as v from 'valibot';
import { getSessionTodos, setSessionTodos } from '../../db/sessions.ts';
import { changeGate, gate, loadGate } from './gate-state.ts';
import { endsOnUser } from './asks.ts';

/** Each list replaces the one before; a status update names only the changed items, by number. */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type Todo = { content: string; status: TodoStatus; evidence?: string };
export type TodoList = { todos: Todo[]; updatedAt: string };
export type TodoChange = { item: number; status: TodoStatus; evidence?: string };

export const MAX_TODOS = 30;
const MAX_CONTENT = 200;
const MAX_EVIDENCE = 300;

const STATUS = v.picklist(['pending', 'in_progress', 'completed']);

/** In a 20-task benchmark the agent resent the whole list 174 times (about 544 characters each) to change one or two statuses. */
export const TODOS_INPUT = v.object({
	todos: v.optional(
		v.pipe(
			v.array(
				v.object({
					content: v.pipe(v.string(), v.minLength(1), v.description('The step, a few words in the imperative, such as "Add the migration"')),
					status: STATUS,
					evidence: v.optional(
						v.pipe(v.string(), v.description('For a completed item: how you checked it, the command or check you ran and what it showed, in a short line')),
					),
				}),
			),
			v.maxLength(MAX_TODOS),
			v.description('The whole list, every item in order with its status: to write it, or to reword, reorder, add or drop items. For status updates use changes.'),
		),
	),
	changes: v.optional(
		v.pipe(
			v.array(
				v.object({
					item: v.pipe(v.number(), v.integer(), v.description("The item's number in your list, counting from 1")),
					status: STATUS,
					evidence: v.optional(v.pipe(v.string(), v.description('For an item now completed: how you checked it and what it showed, in a short line. Left out, a completed item keeps the evidence it had.'))),
				}),
			),
			v.minLength(1),
			v.maxLength(MAX_TODOS),
			v.description('Only the items whose status changed, by number: such as the step just completed, with its evidence, and the next one in_progress.'),
		),
	),
});
export type TodosInput = v.InferOutput<typeof TODOS_INPUT>;

export async function todosFor(id: string): Promise<TodoList | null> {
	const saved = await getSessionTodos(id);
	if (!saved) return null;
	try {
		const list = JSON.parse(saved) as TodoList;
		return Array.isArray(list.todos) ? list : null;
	} catch {
		return null;
	}
}

const evidenceOf = (text: string | undefined): string | undefined => text?.replace(/\s+/g, ' ').trim().slice(0, MAX_EVIDENCE) || undefined;

/** A step's tool calls run at once, so each task's list reads and writes go one after another, or an update would be lost. */
const turns = new Map<string, Promise<unknown>>();

function inTurn<T>(id: string, work: () => Promise<T>): Promise<T> {
	const run = (turns.get(id) ?? Promise.resolve()).then(work, work);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	turns.set(id, settled);
	void settled.then(() => turns.get(id) === settled && turns.delete(id));
	return run;
}

type Saved = { text: string; open: number };

function standing(list: Todo[], numbered: boolean): Saved {
	const done = list.filter((todo) => todo.status === 'completed').length;
	const at = list.findIndex((todo) => todo.status === 'in_progress');
	const open = list.length - done;
	if (open === 0) return { text: `Todo list saved: all ${done} done.`, open };
	const now = at < 0 ? '' : ` Now: ${numbered ? `${at + 1}. ` : ''}${list[at].content}.`;
	return { text: `Todo list saved: ${done}/${list.length} done.${now} Update it again as soon as a step finishes.`, open };
}

async function save(id: string, list: Todo[], at: Date): Promise<void> {
	await setSessionTodos(id, JSON.stringify({ todos: list, updatedAt: at.toISOString() } satisfies TodoList));
	sinceUpdate.delete(id);
	sinceUpdate.set(id, { calls: 0, at: at.getTime() });
	if (sinceUpdate.size > MAX_TRACKED) sinceUpdate.delete(sinceUpdate.keys().next().value!);
}

/**
 * Agents tick steps off in bursts: one wrote its list, made 82 tool calls over 18 minutes without an update, then marked all
 * seven done at once, so the user saw 0/7 jump to 7/7. A tool result is the only way into a running turn (an ACP agent's
 * too), so after this many calls and this long without an update, the next result reminds it of the list.
 */
export const NUDGE_CALLS = 12;
export const NUDGE_MS = 3 * 60_000;
const MAX_TRACKED = 500;
/** Per task, since its list was last written. Only a list written since Anton started is tracked, so a restart sends none. */
const sinceUpdate = new Map<string, { calls: number; at: number }>();

/** Counts one of the Coder's tool calls; the note to add to its result once the list has gone quiet too long, else null. */
export async function todoNudge(id: string, toolName: string, now = Date.now()): Promise<string | null> {
	const mark = sinceUpdate.get(id);
	if (!mark || toolName === 'update_todos') return null;
	mark.calls++;
	if (mark.calls < NUDGE_CALLS || now - mark.at < NUDGE_MS) return null;
	const list = await todosFor(id).catch(() => null);
	const open = list?.todos.filter((todo) => todo.status !== 'completed') ?? [];
	if (!list || open.length === 0) {
		sinceUpdate.delete(id);
		return null;
	}
	const calls = mark.calls;
	const minutes = Math.round((now - mark.at) / 60_000);
	// Once per stretch: the next comes only after as many calls and as long again.
	mark.calls = 0;
	mark.at = now;
	const current = list.todos.findIndex((todo) => todo.status === 'in_progress');
	const step = current < 0 ? `${open.length} of ${list.todos.length} steps are still open` : `step ${current + 1} "${list.todos[current].content}" is still in progress`;
	return (
		`[Todo list: ${step} after ${calls} tool calls and ${minutes} minutes without an update. The user follows the list as your progress: ` +
		'if a step is done, mark it completed (and the next in_progress) with update_todos alongside your next tool call.]'
	);
}

function write(id: string, todos: Todo[], at: Date): Promise<Saved> {
	return inTurn(id, async () => {
		const list = todos
			.map((todo) => {
				const evidence = evidenceOf(todo.evidence);
				return { content: todo.content.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT), status: todo.status, ...(evidence ? { evidence } : {}) };
			})
			.filter((todo) => todo.content)
			.slice(0, MAX_TODOS);
		if (list.length === 0) {
			await setSessionTodos(id, null);
			return { text: 'The todo list is cleared.', open: 0 };
		}
		await save(id, list, at);
		return standing(list, false);
	});
}

export async function writeTodos(id: string, todos: Todo[], at = new Date()): Promise<string> {
	return (await write(id, todos, at)).text;
}

/**
 * A step marked completed with no evidence keeps what it had; one set back to pending or in_progress loses it unless new
 * evidence is sent. A change that cannot be made changes nothing.
 */
function change(id: string, changes: readonly TodoChange[], at: Date): Promise<Saved> {
	return inTurn(id, async () => {
		const list = (await todosFor(id))?.todos ?? [];
		if (list.length === 0) throw new Error('There is no todo list yet. Write it whole with todos.');
		if (changes.length === 0) throw new Error('Give changes, each an item by its number with its new status, or the whole list as todos.');
		const missing = changes.find((step) => !Number.isInteger(step.item) || step.item < 1 || step.item > list.length);
		if (missing) {
			const items = list.map((todo, index) => `${index + 1}. ${todo.content} (${todo.status})`).join('\n');
			throw new Error(`There is no item ${missing.item}: your todo list has ${list.length} item${list.length === 1 ? '' : 's'}, numbered from 1:\n${items}\nNothing was changed.`);
		}
		const next = [...list];
		for (const step of changes) {
			const todo = next[step.item - 1];
			const evidence = evidenceOf(step.evidence) ?? (step.status === 'completed' ? todo.evidence : undefined);
			next[step.item - 1] = { content: todo.content, status: step.status, ...(evidence ? { evidence } : {}) };
		}
		await save(id, next, at);
		return standing(next, true);
	});
}

export async function changeTodos(id: string, changes: readonly TodoChange[], at = new Date()): Promise<string> {
	return (await change(id, changes, at)).text;
}

/** Flue reports a step's tool calls before it runs them and its observers run synchronously, so the note is there when the tool runs. */
const alone = new Map<string, boolean>();
const MAX_NOTED = 200;

type TurnEvent = { type?: string; response?: { output?: { content?: ReadonlyArray<{ type?: string; id?: string; name?: string }> } } };

export function noteTodoStep(event: TurnEvent): void {
	if (event.type !== 'turn') return;
	const calls = (event.response?.output?.content ?? []).filter((part) => part.type === 'toolCall');
	for (const call of calls) if (call.name === 'update_todos' && call.id) alone.set(call.id, calls.length === 1);
	// A call that was never run (a step stopped first) leaves its note; the oldest go.
	for (const key of alone.keys()) {
		if (alone.size <= MAX_NOTED) break;
		alone.delete(key);
	}
}

/** A step that only updated the list cost a model call (34 such steps, 258 s, in a benchmark), so the answer asks for the next update to come with other calls. */
export async function updateTodos(id: string, input: TodosInput, callId?: string, at = new Date()): Promise<string> {
	const lone = callId ? alone.get(callId) === true : false;
	if (callId) alone.delete(callId);
	if (input.todos && input.changes) throw new Error('Give todos or changes, not both: todos replaces the whole list, changes updates items of the saved one by number. Nothing was changed.');
	if (!input.todos && !input.changes) throw new Error('Give changes, each an item by its number with its new status, or the whole list as todos.');
	const saved = input.todos ? await write(id, input.todos, at) : await change(id, input.changes ?? [], at);
	return lone && saved.open > 0 ? `${saved.text} Send the next update with your next step's other tool calls, not as a step of its own.` : saved.text;
}

export function startTodoReply(id: string, now = Date.now()): void {
	const mark = sinceUpdate.get(id);
	if (mark) sinceUpdate.set(id, { calls: 0, at: now });
	changeGate(id, (state) => {
		state.reminded = false;
	});
}

/** Steps still open after the reminder were left open on purpose. */
export const todoReminded = (id: string): boolean => gate(id).reminded;

type Call = { tool: string; isError: boolean };

/** A list left at "0/3" after the work is done reads as work not done. A reply that ends on a question or a plan leaves its steps for the answer. */
export async function todoReminder(id: string, calls: readonly Call[]): Promise<string | null> {
	await loadGate(id);
	if (gate(id).reminded || !calls.some((call) => call.tool === 'update_todos' && !call.isError)) return null;
	if (endsOnUser(id, calls)) return null;
	const list = await todosFor(id);
	const open = list?.todos.filter((todo) => todo.status !== 'completed') ?? [];
	if (!list || open.length === 0) return null;
	changeGate(id, (state) => {
		state.reminded = true;
	});
	return (
		`Your todo list still shows ${open.length} of ${list.todos.length} steps not done: ${open.map((todo) => `"${todo.content}"`).join(', ')}. ` +
		'Do the ones you can still do now: a step that is only large or slow is still yours to finish. The user follows the list as your progress, so then call update_todos to match where the work stands, marking each step you finished completed. ' +
		'Leave a step open only when it needs something from the user (a decision, access, a file), and then say in your reply exactly what it needs. Then end your reply without repeating your answer.'
	);
}
