import type { Session } from '../../core/types.ts';
import { type AttachedFile, withAttachments } from '../../core/attachments.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../../core/errors.ts';
import { MAX_TODO_ATTACHMENTS, shortTodoId, todoBrief, todoStartMessage, type SpaceTodo, type SpaceTodoStatus, type TodoAttachment } from '../../core/space-todos.ts';
import { getSpace, touchSpace } from '../../db/spaces.ts';
import { deleteSpaceTodoRecord, getSpaceTodo, insertSpaceTodo, linkTodoThreadRecord, listSpaceTodos, updateSpaceTodo } from '../../db/space-todos.ts';
import { sendToAgent } from '../tasks/agent-runner.ts';
import { projectAttachment, projectPictures } from '../artifacts/attachments.ts';
import { coordinatorModel } from './coordinator.ts';
import { listSpaceFiles } from './space-files.ts';
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

/** Only files in the project's Library, where the page put them; each once, with the size the Library has. */
async function libraryFiles(spaceId: string, attachments: TodoAttachment[]): Promise<TodoAttachment[]> {
	if (!attachments.length) return [];
	if (attachments.length > MAX_TODO_ATTACHMENTS) throw new InvalidInputError(`Attach up to ${MAX_TODO_ATTACHMENTS} files to a to-do`);
	const library = new Map((await listSpaceFiles(spaceId)).map((file) => [file.path, file]));
	const kept = new Map<string, TodoAttachment>();
	for (const attachment of attachments) {
		const file = library.get(attachment.path);
		if (!file) throw new InvalidInputError(`${attachment.name} is not in the project's files`);
		kept.set(file.path, { name: attachment.name, path: file.path, kind: attachment.kind, size: file.size });
	}
	return [...kept.values()];
}

/** As a message carries them; one deleted from the Library since is left out. */
async function attachedFiles(spaceId: string, todo: SpaceTodo): Promise<AttachedFile[]> {
	const files = await Promise.all(todo.attachments.map((file) => projectAttachment(spaceId, file.path).catch((error: unknown) => (error instanceof NotFoundError ? null : Promise.reject(error)))));
	return files.filter((file): file is AttachedFile => file !== null);
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

export async function createTodo(spaceId: string, input: { title: string; description?: string; attachments?: TodoAttachment[]; createdBy?: SpaceTodo['createdBy'] }): Promise<SpaceTodo> {
	await existingSpace(spaceId);
	const description = (input.description ?? '').trim();
	if (description.length > MAX_TODO_DESCRIPTION) throw new InvalidInputError('The description is too long');
	const attachments = await libraryFiles(spaceId, input.attachments ?? []);
	const todo = await insertSpaceTodo({ spaceId, title: cleanTitle(input.title), description, attachments, createdBy: input.createdBy ?? 'user' });
	await touchSpace(spaceId);
	return todo;
}

/** Set back to open, a to-do leaves whoever had it; marked done, it keeps them. */
export async function editTodo(spaceId: string, todoId: string, change: { title?: string; description?: string; attachments?: TodoAttachment[]; status?: SpaceTodoStatus }): Promise<SpaceTodo> {
	await existingTodo(spaceId, todoId);
	const attachments = change.attachments === undefined ? undefined : await libraryFiles(spaceId, change.attachments);
	return (await updateSpaceTodo(todoId, {
		...(change.title !== undefined ? { title: cleanTitle(change.title) } : {}),
		...(change.description !== undefined ? { description: change.description.trim() } : {}),
		...(attachments !== undefined ? { attachments } : {}),
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

/** Starts an open to-do: a thread of its own with it as the brief, or the coordinator, which may split it over several. Its files go along as a message's would, images as pictures. */
export async function startTodo(spaceId: string, todoId: string, target: 'thread' | 'coordinator'): Promise<{ todo: SpaceTodo; thread?: Session }> {
	const todo = await existingTodo(spaceId, todoId);
	if (todo.status !== 'open') throw new ConflictError('This to-do is already started or done');
	const files = await attachedFiles(spaceId, todo);
	if (target === 'thread') {
		const brief = withAttachments(todoBrief(todo), files, 'project');
		const thread = await startThread(spaceId, { title: todo.title.slice(0, 80), brief }, { wait: false });
		await threadStarted(thread.id, { by: 'you', brief });
		return { todo: await linkTodoToThread(spaceId, todo.id, thread.id), thread };
	}
	const message = withAttachments(todoStartMessage(todo), files, 'project');
	const space = await existingSpace(spaceId);
	const { images, note } = await projectPictures(spaceId, spaceId, message, await coordinatorModel(space));
	await updateSpaceTodo(todo.id, { status: 'in_progress', assignee: 'coordinator' });
	try {
		await sendToAgent(spaceId, note ? `${message}\n\n${note}` : message, 'coordinator', images);
	} catch (error) {
		await updateSpaceTodo(todo.id, { status: 'open', assignee: null });
		throw error;
	}
	await touchSpace(spaceId);
	return { todo: (await getSpaceTodo(todo.id))! };
}
