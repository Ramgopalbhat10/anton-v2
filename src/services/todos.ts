import { getSessionTodos, setSessionTodos } from '../db/sessions.ts';

/**
 * The agent's todo list for a task: the steps of the work it is on, ticked off
 * as it goes, shown as the progress pill above the composer. Each list the
 * agent writes replaces the one before, so a task keeps only its latest.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type Todo = { content: string; status: TodoStatus };
export type TodoList = { todos: Todo[]; updatedAt: string };

/** A list stays short enough to read at a glance; each item a line. */
export const MAX_TODOS = 30;
const MAX_CONTENT = 200;

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

/** Saves the list the agent wrote in place of the last one, and says back where it stands. An empty list clears it. */
export async function writeTodos(id: string, todos: Todo[], at = new Date()): Promise<string> {
	const list = todos
		.map((todo) => ({ content: todo.content.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT), status: todo.status }))
		.filter((todo) => todo.content)
		.slice(0, MAX_TODOS);
	if (list.length === 0) {
		await setSessionTodos(id, null);
		return 'The todo list is cleared.';
	}
	await setSessionTodos(id, JSON.stringify({ todos: list, updatedAt: at.toISOString() } satisfies TodoList));
	const done = list.filter((todo) => todo.status === 'completed').length;
	const current = list.find((todo) => todo.status === 'in_progress');
	if (done === list.length) return `Todo list saved: all ${done} done.`;
	return `Todo list saved: ${done}/${list.length} done.${current ? ` Now: ${current.content}.` : ''} Update it again as soon as a step finishes.`;
}

/** Tasks whose reply in hand was already reminded of its list, so a reply is reminded once. */
const reminded = new Set<string>();

/** A new reply may be reminded again. */
export function startTodoReply(id: string): void {
	reminded.delete(id);
}

type Call = { tool: string; isError: boolean };

/**
 * When a reply that wrote a todo list is about to end with steps still open,
 * what to tell the agent so the list matches where the work stands; null when
 * there is nothing to say. The user reads the list as the agent's progress,
 * and a list left at "0/3" after the work is done reads as work not done.
 * A reply that ends on a question or a plan leaves its steps for the answer.
 */
export async function todoReminder(id: string, calls: readonly Call[]): Promise<string | null> {
	if (reminded.has(id) || !calls.some((call) => call.tool === 'update_todos' && !call.isError)) return null;
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
	const list = await todosFor(id);
	const open = list?.todos.filter((todo) => todo.status !== 'completed') ?? [];
	if (!list || open.length === 0) return null;
	reminded.add(id);
	return (
		`Your todo list still shows ${open.length} of ${list.todos.length} steps not done: ${open.map((todo) => `"${todo.content}"`).join(', ')}. ` +
		'The user follows the list as your progress. Call update_todos now so it matches where the work stands: mark each step you finished completed, ' +
		'and leave open only what is still to do. Then end your reply without repeating your answer.'
	);
}
