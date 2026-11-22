import type { Reasoning } from '../../core/ports.ts';
import type { Session } from '../../core/types.ts';
import { withAttachments } from '../../core/attachments.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../../core/errors.ts';
import {
	TODO_NO_REPO,
	todoAssignMessage,
	todoBrief,
	type SpaceTodo,
	type SpaceTodoCreator,
	type SpaceTodoStatus,
	type TodoPriority,
} from '../../core/space-todos.ts';
import { getProject } from '../../db/projects.ts';
import { getSpace, touchSpace, type Space } from '../../db/spaces.ts';
import {
	claimSpaceTodo,
	deleteSpaceTodoRecord,
	getSpaceTodo,
	insertSpaceTodo,
	linkTodoThreadRecord,
	listSpaceTodos,
	releaseSpaceTodoClaim,
	reorderSpaceTodoRecords,
	updateSpaceTodo,
} from '../../db/space-todos.ts';
import { projectAttachment } from '../artifacts/attachments.ts';
import { findModel } from '../models/models.ts';
import { sendToAgent } from '../tasks/agent-runner.ts';
import { findThread, nudgeThread, startThread } from './spaces.ts';
import { threadStarted } from './thread-reports.ts';

export const MAX_TODO_TITLE = 200;
export const MAX_TODO_DESCRIPTION = 20_000;
export const MAX_TODO_TAGS = 10;
export const MAX_TODO_TAG_LENGTH = 32;
export const MAX_TODO_FILES = 10;

async function existingSpace(spaceId: string): Promise<Space> {
	const space = await getSpace(spaceId);
	if (!space) throw new NotFoundError('Project not found');
	return space;
}

async function existingTodo(spaceId: string, todoId: string): Promise<SpaceTodo> {
	const todo = await getSpaceTodo(todoId);
	if (!todo || todo.spaceId !== spaceId) throw new NotFoundError('To-do not found in this project');
	return todo;
}

function normalizeTags(tags?: string[]): string[] {
	if (!tags) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of tags) {
		const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TODO_TAG_LENGTH);
		if (!cleaned) continue;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(cleaned);
		if (out.length >= MAX_TODO_TAGS) break;
	}
	return out;
}

function normalizeFiles(files?: string[]): string[] {
	if (!files) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of files) {
		const cleaned = raw.trim();
		if (!cleaned || seen.has(cleaned)) continue;
		seen.add(cleaned);
		out.push(cleaned);
		if (out.length >= MAX_TODO_FILES) break;
	}
	return out;
}

function normalizeSourceUrl(url: string | null | undefined): string | null | undefined {
	if (url === undefined) return undefined;
	if (url === null) return null;
	const trimmed = url.trim();
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new InvalidInputError('Source URL must be a valid http or https link');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new InvalidInputError('Source URL must start with http:// or https://');
	}
	return trimmed;
}

function normalizeDueAt(dueAt: string | null | undefined): string | null | undefined {
	if (dueAt === undefined) return undefined;
	if (dueAt === null) return null;
	const trimmed = dueAt.trim();
	if (!trimmed) return null;
	if (Number.isNaN(Date.parse(trimmed))) throw new InvalidInputError('Due date must be a valid date');
	return trimmed;
}

async function normalizeProjectId(space: Space, projectId: string | null | undefined, repo?: string): Promise<string | null | undefined> {
	if (projectId === undefined && repo === undefined) return undefined;
	if (projectId === null || projectId === '') return null;
	if (projectId === TODO_NO_REPO) return TODO_NO_REPO;
	if (projectId) {
		if (!space.repoIds.includes(projectId)) throw new InvalidInputError('That repository is not in this project');
		return projectId;
	}
	if (repo !== undefined) {
		const wanted = repo.trim().toLowerCase();
		if (!wanted || wanted === 'auto') return null;
		if (wanted === TODO_NO_REPO || wanted === 'no repository' || wanted === 'chat') return TODO_NO_REPO;
		const repos = await Promise.all(space.repoIds.map((id) => getProject(id)));
		const match = repos.find((item) => item && (item.repoFullName.toLowerCase() === wanted || item.repoFullName.split('/').pop()?.toLowerCase() === wanted));
		if (!match) throw new InvalidInputError(`${repo} is not one of this project's repositories`);
		return match.id;
	}
	return undefined;
}

async function checkModel(model: string | null | undefined): Promise<void> {
	if (model && !(await findModel(model))) throw new InvalidInputError(`Unknown model: ${model}`);
}

export async function listTodos(spaceId: string): Promise<SpaceTodo[]> {
	await existingSpace(spaceId);
	return listSpaceTodos(spaceId);
}

export async function findTodo(spaceId: string, ref: string): Promise<SpaceTodo> {
	const wanted = ref.trim().replace(/^\[|\]$/g, '').replace(/^todo:/, '');
	const todos = await listSpaceTodos(spaceId);
	const exact = todos.find((todo) => todo.id === wanted || todo.id === `todo_${wanted}`);
	if (exact) return exact;
	const prefixed = wanted.length >= 4 ? todos.filter((todo) => todo.id.startsWith(wanted) || todo.id.replace(/^todo_/, '').startsWith(wanted)) : [];
	if (prefixed.length === 1) return prefixed[0];
	const titled = todos.filter((todo) => todo.title.toLowerCase() === wanted.toLowerCase());
	if (titled.length === 1) return titled[0];
	throw new NotFoundError(`No to-do ${ref} in this project`);
}

export type CreateTodoInput = {
	title: string;
	description?: string;
	priority?: TodoPriority | null;
	tags?: string[];
	projectId?: string | null;
	repo?: string;
	model?: string | null;
	reasoning?: Reasoning | null;
	planMode?: boolean;
	files?: string[];
	dueAt?: string | null;
	sourceUrl?: string | null;
	createdBy?: SpaceTodoCreator;
};

export async function createTodo(spaceId: string, input: CreateTodoInput): Promise<SpaceTodo> {
	const space = await existingSpace(spaceId);
	const title = input.title.trim();
	if (!title) throw new InvalidInputError('Give the to-do a title');
	if (title.length > MAX_TODO_TITLE) throw new InvalidInputError(`Keep the title under ${MAX_TODO_TITLE} characters`);
	const description = (input.description ?? '').trim();
	if (description.length > MAX_TODO_DESCRIPTION) throw new InvalidInputError(`Keep the description under ${MAX_TODO_DESCRIPTION.toLocaleString()} characters`);
	await checkModel(input.model);
	const projectId = (await normalizeProjectId(space, input.projectId, input.repo)) ?? null;
	const dueAt = normalizeDueAt(input.dueAt) ?? null;
	const sourceUrl = normalizeSourceUrl(input.sourceUrl) ?? null;
	const todo = await insertSpaceTodo({
		spaceId,
		title,
		description,
		priority: input.priority ?? null,
		tags: normalizeTags(input.tags),
		projectId,
		model: input.model || null,
		reasoning: input.reasoning ?? null,
		planMode: Boolean(input.planMode),
		files: normalizeFiles(input.files),
		dueAt,
		sourceUrl,
		createdBy: input.createdBy ?? 'user',
	});
	await touchSpace(spaceId);
	return todo;
}

export type EditTodoInput = Partial<{
	title: string;
	description: string;
	status: SpaceTodoStatus;
	priority: TodoPriority | null;
	tags: string[];
	projectId: string | null;
	repo: string;
	model: string | null;
	reasoning: Reasoning | null;
	planMode: boolean;
	files: string[];
	dueAt: string | null;
	sourceUrl: string | null;
}>;

export async function editTodo(spaceId: string, todoId: string, change: EditTodoInput): Promise<SpaceTodo> {
	const [space, current] = await Promise.all([existingSpace(spaceId), existingTodo(spaceId, todoId)]);
	if (change.title !== undefined) {
		const title = change.title.trim();
		if (!title) throw new InvalidInputError('Give the to-do a title');
		if (title.length > MAX_TODO_TITLE) throw new InvalidInputError(`Keep the title under ${MAX_TODO_TITLE} characters`);
	}
	if (change.description !== undefined && change.description.length > MAX_TODO_DESCRIPTION) {
		throw new InvalidInputError(`Keep the description under ${MAX_TODO_DESCRIPTION.toLocaleString()} characters`);
	}
	await checkModel(change.model);
	const projectId = await normalizeProjectId(space, change.projectId, change.repo);
	const dueAt = normalizeDueAt(change.dueAt);
	const sourceUrl = normalizeSourceUrl(change.sourceUrl);
	const now = new Date().toISOString();
	let completedAt: string | null | undefined;
	let completedBy: 'auto' | 'manual' | null | undefined;
	let assigneeKind: 'unassigned' | undefined;
	if (change.status === 'done') {
		completedAt = current.completedAt ?? now;
		completedBy = 'manual';
	} else if (change.status === 'open') {
		completedAt = null;
		completedBy = null;
		if (current.threadIds.length === 0) assigneeKind = 'unassigned';
	} else if (change.status === 'in_progress' || change.status === 'triaging' || change.status === 'cancelled') {
		completedAt = null;
		completedBy = null;
	}
	const updated = await updateSpaceTodo(todoId, {
		...(change.title !== undefined ? { title: change.title.trim() } : {}),
		...(change.description !== undefined ? { description: change.description.trim() } : {}),
		...(change.status !== undefined ? { status: change.status } : {}),
		...(assigneeKind !== undefined ? { assigneeKind } : {}),
		...(change.priority !== undefined ? { priority: change.priority } : {}),
		...(change.tags !== undefined ? { tags: normalizeTags(change.tags) } : {}),
		...(projectId !== undefined ? { projectId } : {}),
		...(change.model !== undefined ? { model: change.model || null } : {}),
		...(change.reasoning !== undefined ? { reasoning: change.reasoning } : {}),
		...(change.planMode !== undefined ? { planMode: change.planMode } : {}),
		...(change.files !== undefined ? { files: normalizeFiles(change.files) } : {}),
		...(dueAt !== undefined ? { dueAt } : {}),
		...(sourceUrl !== undefined ? { sourceUrl } : {}),
		...(completedAt !== undefined ? { completedAt } : {}),
		...(completedBy !== undefined ? { completedBy } : {}),
	});
	return updated!;
}

export async function removeTodo(spaceId: string, todoId: string): Promise<void> {
	await existingTodo(spaceId, todoId);
	await deleteSpaceTodoRecord(todoId);
}

export async function reorderTodos(spaceId: string, orderedIds: string[]): Promise<SpaceTodo[]> {
	await existingSpace(spaceId);
	await reorderSpaceTodoRecords(spaceId, orderedIds);
	return listSpaceTodos(spaceId);
}

/** Reads every attached Library file upfront so missing or unreadable specs fail before claiming or starting work. */
async function resolveTodoAttachments(spaceId: string, files: string[]) {
	if (files.length === 0) return [];
	const resolved = [];
	for (const name of files) {
		try {
			resolved.push(await projectAttachment(spaceId, name));
		} catch (error) {
			if (error instanceof NotFoundError) {
				throw new ConflictError(`Attached project file "${name}" is missing. Restore it in Files or detach it from the to-do before assigning.`);
			}
			throw new ConflictError(`Attached project file "${name}" could not be read. Check Files or detach it from the to-do before assigning.`);
		}
	}
	return resolved;
}

export async function linkTodoToThread(spaceId: string, todoId: string, sessionId: string): Promise<SpaceTodo> {
	const current = await existingTodo(spaceId, todoId);
	await linkTodoThreadRecord(todoId, sessionId);
	const now = new Date().toISOString();
	const updated = await updateSpaceTodo(todoId, {
		status: current.status === 'open' || current.status === 'triaging' || current.status === 'done' ? 'in_progress' : current.status,
		assigneeKind: current.assigneeKind === 'coordinator' ? 'coordinator' : 'thread',
		assignedAt: current.assignedAt ?? now,
		completedAt: null,
		completedBy: null,
	});
	return updated!;
}

export type AssignTodoInput =
	| { target: 'coordinator'; note?: string; retry?: boolean }
	| {
			target: 'new-thread';
			id?: string;
			projectId?: string | null;
			repo?: string;
			model?: string;
			reasoning?: Reasoning;
			planMode?: boolean;
			note?: string;
			retry?: boolean;
	  }
	| { target: 'thread'; threadId: string; note?: string; retry?: boolean };

export async function assignTodo(spaceId: string, todoId: string, input: AssignTodoInput): Promise<{ todo: SpaceTodo; thread?: Session }> {
	const [space, todo] = await Promise.all([existingSpace(spaceId), existingTodo(spaceId, todoId)]);
	if (space.state === 'archived') throw new ConflictError('The project is archived; restore it to assign to-dos');
	const allowTriagingRetry = Boolean(input.retry);
	if (todo.status !== 'open' && !(allowTriagingRetry && todo.status === 'triaging' && todo.threadIds.length === 0)) {
		throw new ConflictError('This to-do is already assigned or completed');
	}

	// Validate attachments, repo, model, and target thread BEFORE claiming so errors never mutate the to-do.
	const attachments = await resolveTodoAttachments(spaceId, todo.files);
	const now = new Date().toISOString();

	if (input.target === 'coordinator') {
		let repoLabel: string | null = null;
		if (todo.projectId === TODO_NO_REPO) repoLabel = TODO_NO_REPO;
		else if (todo.projectId) {
			if (!space.repoIds.includes(todo.projectId)) {
				throw new InvalidInputError('The repository selected on this to-do is no longer in this project. Pick another repository before assigning.');
			}
			repoLabel = (await getProject(todo.projectId))?.repoFullName ?? null;
		}
		const rawMessage = todoAssignMessage({
			id: todo.id,
			title: todo.title,
			priority: todo.priority,
			repo: repoLabel,
			tags: todo.tags,
			dueAt: todo.dueAt,
			sourceUrl: todo.sourceUrl,
			files: todo.files,
			description: todo.description,
			note: input.note,
		});
		const message = attachments.length ? withAttachments(rawMessage, attachments, 'project') : rawMessage;
		const claimed = await claimSpaceTodo(todo.id, spaceId, { status: 'triaging', assigneeKind: 'coordinator', assignedAt: now }, { allowTriagingRetry });
		if (!claimed) throw new ConflictError('This to-do is already assigned or completed');
		try {
			await sendToAgent(spaceId, message, 'coordinator');
		} catch (error) {
			await releaseSpaceTodoClaim(todo.id, spaceId, now, todo);
			throw error;
		}
		await touchSpace(spaceId);
		return { todo: claimed };
	}

	const baseBrief = todoBrief(todo);
	const fullBrief = input.note?.trim() ? `${baseBrief}\n\n${input.note.trim()}` : baseBrief;
	const briefWithFiles = attachments.length ? withAttachments(fullBrief, attachments, 'project') : fullBrief;

	if (input.target === 'new-thread') {
		const projectId =
			input.projectId !== undefined
				? input.projectId
				: input.repo !== undefined
					? undefined
					: todo.projectId === TODO_NO_REPO
						? null
						: (todo.projectId ?? undefined);
		if (projectId && !space.repoIds.includes(projectId)) {
			throw new InvalidInputError('That repository is not in this project');
		}
		await checkModel(input.model ?? todo.model);
		const claimed = await claimSpaceTodo(todo.id, spaceId, { status: 'in_progress', assigneeKind: 'thread', assignedAt: now }, { allowTriagingRetry });
		if (!claimed) throw new ConflictError('This to-do is already assigned or completed');
		let thread: Session;
		try {
			thread = await startThread(
				spaceId,
				{
					id: input.id,
					title: todo.title,
					brief: briefWithFiles,
					projectId,
					repo: input.repo,
					model: input.model ?? todo.model ?? undefined,
					reasoning: input.reasoning ?? todo.reasoning ?? undefined,
					planMode: input.planMode ?? todo.planMode,
				},
				{ wait: false },
			);
		} catch (error) {
			await releaseSpaceTodoClaim(todo.id, spaceId, now, todo);
			throw error;
		}
		await linkTodoThreadRecord(todo.id, thread.id);
		await threadStarted(thread.id, { by: 'you', brief: fullBrief });
		return { todo: (await getSpaceTodo(todo.id))!, thread };
	}

	const targetThread = await findThread(spaceId, input.threadId);
	const claimed = await claimSpaceTodo(todo.id, spaceId, { status: 'in_progress', assigneeKind: 'thread', assignedAt: now }, { allowTriagingRetry });
	if (!claimed) throw new ConflictError('This to-do is already assigned or completed');
	let nudged: Session;
	try {
		nudged = await nudgeThread(spaceId, targetThread.id, briefWithFiles);
	} catch (error) {
		await releaseSpaceTodoClaim(todo.id, spaceId, now, todo);
		throw error;
	}
	await linkTodoThreadRecord(todo.id, targetThread.id);
	return { todo: (await getSpaceTodo(todo.id))!, thread: nudged };
}

