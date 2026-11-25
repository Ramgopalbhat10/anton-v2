import type { Project, RunOn, Session } from '../../core/types.ts';
import { threadBrief } from '../../core/briefs.ts';
import { type AttachedFile, withAttachments } from '../../core/attachments.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../../core/errors.ts';
import { MAX_TODO_ATTACHMENTS, MAX_TODO_DESCRIPTION, MAX_TODO_TITLE, shortTodoId, todoBrief, todoRef, todoStartMessage, type SpaceTodo, type SpaceTodoStatus, type TodoAttachment } from '../../core/space-todos.ts';
import { getSpace, touchSpace } from '../../db/spaces.ts';
import { deleteSpaceTodoRecord, getSpaceTodo, insertSpaceTodo, linkTodoThreadRecord, listSpaceTodos, updateSpaceTodo } from '../../db/space-todos.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { sendToAgent } from '../tasks/agent-runner.ts';
import { projectAttachment, projectPictures } from '../artifacts/attachments.ts';
import { findModel } from '../models/models.ts';
import { coordinatorModel } from './coordinator.ts';
import { listSpaceFiles } from './space-files.ts';
import { nudgeThread, spaceRepos, startThread, type ThreadInput } from './spaces.ts';
import { hostRunnerAvailable } from '../tasks/runners.ts';
import { threadStarted } from './thread-reports.ts';
import { type RepoPlan, todoThreadPlan } from './thread-repos.ts';

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
	const wanted = todoRef(ref);
	const todos = await listSpaceTodos(spaceId);
	const found =
		todos.find((todo) => todo.id === wanted || shortTodoId(todo.id) === wanted) ??
		todos.filter((todo) => todo.title.toLowerCase() === wanted.toLowerCase()).at(0);
	if (!found) throw new NotFoundError(`No to-do ${ref} in this project`);
	return found;
}

type TodoFields = { title: string; description?: string; attachments?: TodoAttachment[]; threadModel?: SpaceTodo['threadModel']; repos?: string[]; runOn?: RunOn };

/** Each once, in the order picked, and only the project's own. */
async function projectRepos(spaceId: string, repos: string[] | undefined): Promise<string[] | undefined> {
	if (repos === undefined) return undefined;
	const space = await existingSpace(spaceId);
	const unique = [...new Set(repos)];
	const outside = unique.find((id) => !space.repoIds.includes(id));
	if (outside) throw new InvalidInputError('That repository is not in this project');
	return unique;
}

function checkRunOn(runOn: RunOn | undefined): void {
	if (runOn === 'host' && !hostRunnerAvailable()) throw new InvalidInputError('Every task already runs on this server.');
}

async function checkThreadModel(choice: SpaceTodo['threadModel'] | undefined): Promise<void> {
	if (choice && !(await findModel(choice.model))) {
		throw new InvalidInputError(`Unknown model: ${choice.model}. Choose a different main thread model or use the project default.`);
	}
}

export async function createTodo(spaceId: string, input: TodoFields & { createdBy?: SpaceTodo['createdBy'] }): Promise<SpaceTodo> {
	await existingSpace(spaceId);
	const description = (input.description ?? '').trim();
	if (description.length > MAX_TODO_DESCRIPTION) throw new InvalidInputError('The description is too long');
	const attachments = await libraryFiles(spaceId, input.attachments ?? []);
	await checkThreadModel(input.threadModel);
	const repos = await projectRepos(spaceId, input.repos);
	checkRunOn(input.runOn);
	const todo = await insertSpaceTodo({ spaceId, title: cleanTitle(input.title), description, attachments, threadModel: input.threadModel, repos, runOn: input.runOn, createdBy: input.createdBy ?? 'user' });
	await touchSpace(spaceId);
	return todo;
}

/** Set back to open, a to-do leaves whoever had it; marked done, it keeps them. */
export async function editTodo(spaceId: string, todoId: string, change: Partial<TodoFields> & { status?: SpaceTodoStatus }): Promise<SpaceTodo> {
	await existingTodo(spaceId, todoId);
	const attachments = change.attachments === undefined ? undefined : await libraryFiles(spaceId, change.attachments);
	await checkThreadModel(change.threadModel);
	const repos = await projectRepos(spaceId, change.repos);
	checkRunOn(change.runOn);
	return (await updateSpaceTodo(todoId, {
		...(change.title !== undefined ? { title: cleanTitle(change.title) } : {}),
		...(change.description !== undefined ? { description: change.description.trim() } : {}),
		...(attachments !== undefined ? { attachments } : {}),
		...(change.threadModel !== undefined ? { threadModel: change.threadModel } : {}),
		...(repos !== undefined ? { repos } : {}),
		...(change.runOn !== undefined ? { runOn: change.runOn } : {}),
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

export type TodoHandoffs = { entries: { id: string; text: string }[]; latestIsHandoff: boolean };

export async function coordinatorTodo(spaceId: string, { entries, latestIsHandoff }: TodoHandoffs, ref?: string): Promise<{ todo: SpaceTodo; text?: string } | null> {
	const wanted = ref ? todoRef(ref) : null;
	const fullId = wanted?.startsWith('todo_') ? wanted : null;
	const infer = entries.length === 1 && latestIsHandoff;
	const handoff = infer ? entries[0] : entries.find(({ id }) => id === (fullId ? shortTodoId(fullId) : wanted));
	if (!handoff && entries.length > 1) {
		throw new InvalidInputError(`This reply has multiple project to-do handoffs. Pass the matching todo_id: ${entries.map(({ id }) => `[todo:${id}]`).join(', ')}.`);
	}
	const id = handoff?.id ?? ref;
	if (!id) return null;
	const todo = handoff && fullId && !infer ? await existingTodo(spaceId, fullId) : await findTodo(spaceId, id);
	return { todo, text: handoff?.text };
}

/** A thread given no repository goes to the to-do's first tagged one that is still in the project. */
export async function startTodoThread(todo: SpaceTodo, input: Omit<ThreadInput, 'model' | 'reasoning' | 'runOn'>): Promise<{ todo: SpaceTodo; thread: Session }> {
	const unnamed = input.projectId === undefined && !input.repo?.trim();
	const space = unnamed && todo.repos.length ? await getSpace(todo.spaceId) : null;
	const tagged = space ? todo.repos.find((id) => space.repoIds.includes(id)) : undefined;
	const thread = await startThread(todo.spaceId, { ...input, ...(tagged ? { projectId: tagged } : {}), model: todo.threadModel?.model, reasoning: todo.threadModel?.reasoning ?? undefined, runOn: todo.runOn }, { wait: false });
	return { thread, todo: await linkTodoToThread(todo.spaceId, todo.id, thread.id) };
}

export async function messageTodoThread(todo: SpaceTodo, threadId: string, message: string): Promise<void> {
	if (todo.threadModel) throw new ConflictError('This to-do has its own main thread model. Use start_thread with its todo_id instead of messaging an existing thread.');
	if (todo.runOn === 'host' && (await getSessionRecord(threadId))?.runOn !== 'host')
		throw new ConflictError('This to-do runs on this server. Use start_thread with its todo_id instead of messaging a thread in a sandbox.');
	await nudgeThread(todo.spaceId, threadId, message);
	await linkTodoToThread(todo.spaceId, todo.id, threadId);
}

const threadTitle = (todo: SpaceTodo, repo: string | null, several: boolean) =>
	(several && repo ? `${todo.title} (${repo.split('/').pop()})` : todo.title).slice(0, 80);

async function startTodoThreadIn(todo: SpaceTodo, entry: RepoPlan, files: AttachedFile[], several: boolean): Promise<{ todo: SpaceTodo; thread: Session }> {
	const brief = withAttachments(threadBrief(todoBrief(todo), entry.context, entry.part), files, 'project');
	const started = await startTodoThread(todo, { title: threadTitle(todo, entry.repo, several), brief, projectId: entry.projectId });
	await threadStarted(started.thread.id, { by: 'you', brief });
	return started;
}

/** For `set_repo`: a thread of the same to-do in each of these repositories, after the user picked them in another thread. */
export async function startTodoThreadsIn(todoId: string, repos: Project[], from: string): Promise<Session[]> {
	const todo = await getSpaceTodo(todoId);
	if (!todo) throw new NotFoundError('To-do not found');
	const files = await attachedFiles(todo.spaceId, todo);
	const threads: Session[] = [];
	for (const project of repos) {
		const context = `The user chose several repositories for this to-do; another thread works in ${from}, and this one works only in ${project.repoFullName}.`;
		threads.push((await startTodoThreadIn(todo, { projectId: project.id, repo: project.repoFullName, context, part: `its changes in ${project.repoFullName}` }, files, true)).thread);
	}
	return threads;
}

/** Starts an open to-do: a thread of its own with it as the brief, or the coordinator, which may split it over several. Its files go along as a message's would, images as pictures. */
export async function startTodo(spaceId: string, todoId: string, target: 'thread' | 'coordinator'): Promise<{ todo: SpaceTodo; thread?: Session; threads?: Session[]; submissionId?: string }> {
	const todo = await existingTodo(spaceId, todoId);
	if (todo.status !== 'open') throw new ConflictError('This to-do is already started or done');
	const files = await attachedFiles(spaceId, todo);
	if (target === 'thread') {
		const plan = await todoThreadPlan(await existingSpace(spaceId), todo);
		const threads: Session[] = [];
		let latest = todo;
		for (const entry of plan) {
			const started = await startTodoThreadIn(todo, entry, files, plan.length > 1);
			threads.push(started.thread);
			latest = started.todo;
		}
		return { todo: latest, thread: threads[0], threads };
	}
	const space = await existingSpace(spaceId);
	const tagged = (await spaceRepos(space)).filter((project) => todo.repos.includes(project.id)).map((project) => project.repoFullName);
	const message = withAttachments(todoStartMessage(todo, tagged), files, 'project');
	const { images, note } = await projectPictures(spaceId, spaceId, message, await coordinatorModel(space));
	await checkThreadModel(todo.threadModel);
	await updateSpaceTodo(todo.id, { status: 'in_progress', assignee: 'coordinator' });
	const submissionId = await sendToAgent(spaceId, note ? `${message}\n\n${note}` : message, 'coordinator', images).catch(async (error: unknown) => {
		await updateSpaceTodo(todo.id, { status: 'open', assignee: null });
		throw error;
	});
	await touchSpace(spaceId);
	return { todo: (await getSpaceTodo(todo.id))!, submissionId };
}
