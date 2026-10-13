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
	return `Todo list saved: ${done}/${list.length} done.${current ? ` Now: ${current.content}` : ''}`;
}
