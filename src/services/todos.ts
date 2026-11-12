import * as v from 'valibot';
import { getSessionTodos, setSessionTodos } from '../db/sessions.ts';
import { changeGate, gate, loadGate } from './gate-state.ts';

/**
 * The agent's todo list for a task: the steps of the work it is on, ticked off
 * as it goes, shown as the progress pill above the composer. Each list the
 * agent writes replaces the one before, so a task keeps only its latest; a
 * status update names only the items that changed, by number, and changes the
 * saved list in place.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
/** `evidence` is how a finished step was checked: the command or check, and what it showed. */
export type Todo = { content: string; status: TodoStatus; evidence?: string };
export type TodoList = { todos: Todo[]; updatedAt: string };
/** One item's new status, by its number in the saved list counting from 1, and its evidence when given. */
export type TodoChange = { item: number; status: TodoStatus; evidence?: string };

/** A list stays short enough to read at a glance; each item a line. */
export const MAX_TODOS = 30;
const MAX_CONTENT = 200;
const MAX_EVIDENCE = 300;

const STATUS = v.picklist(['pending', 'in_progress', 'completed']);

/**
 * `update_todos`'s input: the whole list, or only the items that changed. In a
 * 20-task benchmark run the agent sent the whole list with its evidence 174
 * times, about 544 characters each, to change one or two statuses; those are
 * output tokens, and stay in the conversation for every later step.
 */
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

/**
 * A step's tool calls run at once, so two updates of one list in a step would
 * each read the list before the other wrote it, and one would be lost. Each
 * task's reads and writes of its list go one after another.
 */
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

/** Where the list stands, in a line; a list updated by number says the number of the step in hand, to count from next time. */
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

/** Saves the list the agent wrote in place of the last one, and says back where it stands. An empty list clears it. */
export async function writeTodos(id: string, todos: Todo[], at = new Date()): Promise<string> {
	return (await write(id, todos, at)).text;
}

/**
 * Sets the status of each item named by number, and its evidence when given,
 * leaving every other item as it was saved. A step marked completed with no
 * evidence keeps what it had, so ticking off a step checked earlier needs no
 * repeat; a step set back to pending or in_progress loses it unless new
 * evidence is sent, since a check of work reopened no longer says it is done.
 * A change that cannot be made changes nothing, and its error says how to
 * make it, listing the items by number when one is not on the list.
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

/** Changes the saved list item by item (`change`), and says back where it stands. */
export async function changeTodos(id: string, changes: readonly TodoChange[], at = new Date()): Promise<string> {
	return (await change(id, changes, at)).text;
}

/**
 * Whether each todo update was the only tool call of its model step, by call
 * id, noted from the runtime's `turn` event. Flue reports a model step's
 * output, its tool calls among it, before it runs any of them, and its event
 * observers run synchronously, so the note is there by the time the tool runs.
 * A call the note never reached (no event, another path) is taken as not alone.
 */
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

/**
 * Runs an `update_todos` call: the whole list (`writeTodos`) or the items that
 * changed (`changeTodos`), never both. A model step that only updated the list
 * cost a model call over the whole conversation: in the benchmark run 34 steps
 * did nothing else, 258 seconds in all, though the prompt says to send it with
 * the next step's tool calls. Such an update is saved as any other, and while
 * steps are still open its answer asks for the next one to come with other
 * calls. The last update of a reply comes alone by right, with every step done.
 */
export async function updateTodos(id: string, input: TodosInput, callId?: string, at = new Date()): Promise<string> {
	const lone = callId ? alone.get(callId) === true : false;
	if (callId) alone.delete(callId);
	if (input.todos && input.changes) throw new Error('Give todos or changes, not both: todos replaces the whole list, changes updates items of the saved one by number. Nothing was changed.');
	if (!input.todos && !input.changes) throw new Error('Give changes, each an item by its number with its new status, or the whole list as todos.');
	const saved = input.todos ? await write(id, input.todos, at) : await change(id, input.changes ?? [], at);
	return lone && saved.open > 0 ? `${saved.text} Send the next update with your next step's other tool calls, not as a step of its own.` : saved.text;
}

/** A new reply may be reminded again. A reply is reminded once; that it was is kept with the task's checks (`gate-state.ts`). */
export function startTodoReply(id: string): void {
	changeGate(id, (state) => {
		state.reminded = false;
	});
}

/** Whether the reply in hand was reminded of its list already: steps still open after that were left open on purpose. */
export const todoReminded = (id: string): boolean => gate(id).reminded;

type Call = { tool: string; isError: boolean };

/**
 * When a reply that wrote a todo list is about to end with steps still open,
 * what to tell the agent so the list matches where the work stands; null when
 * there is nothing to say. The user reads the list as the agent's progress,
 * and a list left at "0/3" after the work is done reads as work not done.
 * A reply that ends on a question or a plan leaves its steps for the answer.
 * A step is left open only for something the user must give: told it may leave
 * open what "cannot be done", a model that judged a job too large for the time
 * it thought it had marked the rest open and stopped.
 */
export async function todoReminder(id: string, calls: readonly Call[]): Promise<string | null> {
	await loadGate(id);
	if (gate(id).reminded || !calls.some((call) => call.tool === 'update_todos' && !call.isError)) return null;
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
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
