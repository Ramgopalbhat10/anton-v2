import type { Session } from '../../core/types.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../../core/errors.ts';
import { shortTodoId, todoBrief, todoStartMessage, type SpaceTodo, type SpaceTodoStatus } from '../../core/space-todos.ts';
import { getSpace, touchSpace } from '../../db/spaces.ts';
import { deleteSpaceTodoRecord, getSpaceTodo, insertSpaceTodo, linkTodoThreadRecord, listSpaceTodos, updateSpaceTodo } from '../../db/space-todos.ts';
import { sendToAgent } from '../tasks/agent-runner.ts';
import { startThread } from './spaces.ts';
import { threadStarted } from './thread-reports.ts';

export const MAX_TODO_TITLE = 200;
export const MAX_TODO_DESCRIPTION = 20_000;

async function existingSpace(spaceId: string) {
	const space = await getSpace(spaceId);
	if (!space) throw new NotFoundError('Project not found');
	return space;
}

async function existingTodo(spaceId: string, todoId: string): Promise<SpaceTodo> {
	const todo = await getSpaceTodo(todoId);
	if (!todo || todo.spaceId !== spaceId) throw new NotFoundError('To-do not found in this project');
	return todo;
}

function cleanTitle(title: string): string {
	const clean = title.trim();
	if (!clean) throw new InvalidInputError('Give the to-do a title');
	if (clean.length > MAX_TODO_TITLE) throw new InvalidInputError(`Keep the title under ${MAX_TODO_TITLE} characters`);
	return clean;
}

export async function listTodos(spaceId: string): Promise<SpaceTodo[]> {
	await existingSpace(spaceId);
	return listSpaceTodos(spaceId);
}

/** By its id, the short id the coordinator is shown, or its exact title. */
export async function findTodo(spaceId: string, ref: string): Promise<SpaceTodo> {
	const wanted = ref.trim().replace(/^\[|\]$/g, '').replace(/^todo:/, '');
	const todos = await listSpaceTodos(spaceId);
	const found =
		todos.find((todo) => todo.id === wanted || shortTodoId(todo.id) === wanted) ??
		todos.filter((todo) => todo.title.toLowerCase() === wanted.toLowerCase()).at(0);
	if (!found) throw new NotFoundError(`No to-do ${ref} in this project`);
	return found;
}

export async function createTodo(spaceId: string, input: { title: string; description?: string; createdBy?: SpaceTodo['createdBy'] }): Promise<SpaceTodo> {
	await existingSpace(spaceId);
	const description = (input.description ?? '').trim();
	if (description.length > MAX_TODO_DESCRIPTION) throw new InvalidInputError('The description is too long');
	const todo = await insertSpaceTodo({ spaceId, title: cleanTitle(input.title), description, createdBy: input.createdBy ?? 'user' });
	await touchSpace(spaceId);
	return todo;
}

/** Set back to open, a to-do leaves whoever had it; marked done, it keeps them. */
export async function editTodo(spaceId: string, todoId: string, change: { title?: string; description?: string; status?: SpaceTodoStatus }): Promise<SpaceTodo> {
	await existingTodo(spaceId, todoId);
	return (await updateSpaceTodo(todoId, {
		...(change.title !== undefined ? { title: cleanTitle(change.title) } : {}),
		...(change.description !== undefined ? { description: change.description.trim() } : {}),
		...(change.status === 'open' ? { status: 'open', assignee: null, completedAt: null } : {}),
		...(change.status === 'done' ? { status: 'done', completedAt: new Date().toISOString() } : {}),
	}))!;
}

export async function removeTodo(spaceId: string, todoId: string): Promise<void> {
	await deleteSpaceTodoRecord(await existingTodo(spaceId, todoId));
}

/** A thread working on a to-do; the coordinator calls it for each thread it starts or messages for one. */
export async function linkTodoToThread(spaceId: string, todoId: string, sessionId: string): Promise<SpaceTodo> {
	const todo = await existingTodo(spaceId, todoId);
	await linkTodoThreadRecord(todo.id, sessionId);
	return (await updateSpaceTodo(todo.id, { status: 'in_progress', assignee: todo.assignee ?? 'thread', completedAt: null }))!;
}

/** Starts an open to-do: a thread of its own with it as the brief, or the coordinator, which may split it over several. */
export async function startTodo(spaceId: string, todoId: string, target: 'thread' | 'coordinator'): Promise<{ todo: SpaceTodo; thread?: Session }> {
	const todo = await existingTodo(spaceId, todoId);
	if (todo.status !== 'open') throw new ConflictError('This to-do is already started or done');
	if (target === 'thread') {
		const brief = todoBrief(todo);
		const thread = await startThread(spaceId, { title: todo.title.slice(0, 80), brief }, { wait: false });
		await threadStarted(thread.id, { by: 'you', brief });
		return { todo: await linkTodoToThread(spaceId, todo.id, thread.id), thread };
	}
	await updateSpaceTodo(todo.id, { status: 'in_progress', assignee: 'coordinator' });
	try {
		await sendToAgent(spaceId, todoStartMessage(todo), 'coordinator');
	} catch (error) {
		await updateSpaceTodo(todo.id, { status: 'open', assignee: null });
		throw error;
	}
	await touchSpace(spaceId);
	return { todo: (await getSpaceTodo(todo.id))! };
}
