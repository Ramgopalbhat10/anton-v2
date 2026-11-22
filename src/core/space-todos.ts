import type { Reasoning } from './ports.ts';

export const TODO_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

export const PRIORITY_LABEL: Record<TodoPriority, string> = {
	urgent: 'Urgent',
	high: 'High',
	medium: 'Medium',
	low: 'Low',
};

export const PRIORITY_RANK: Record<TodoPriority, number> = {
	urgent: 0,
	high: 1,
	medium: 2,
	low: 3,
};

export const SPACE_TODO_STATUSES = ['open', 'triaging', 'in_progress', 'done', 'cancelled'] as const;
export type SpaceTodoStatus = (typeof SPACE_TODO_STATUSES)[number];

export type SpaceTodoAssignee = 'unassigned' | 'coordinator' | 'thread';
export type SpaceTodoCreator = 'user' | 'coordinator' | 'routine';
export type SpaceTodoCompletedBy = 'auto' | 'manual';

/** Stored in `projectId` when a todo explicitly targets no repository (a chat thread). `null` means unspecified / project default. */
export const TODO_NO_REPO = 'none';

export type SpaceTodo = {
	id: string;
	spaceId: string;
	title: string;
	description: string;
	status: SpaceTodoStatus;
	assigneeKind: SpaceTodoAssignee;
	priority: TodoPriority | null;
	tags: string[];
	projectId: string | null;
	model: string | null;
	reasoning: Reasoning | null;
	planMode: boolean;
	files: string[];
	dueAt: string | null;
	sourceUrl: string | null;
	position: number;
	createdBy: SpaceTodoCreator;
	threadIds: string[];
	assignedAt: string | null;
	completedAt: string | null;
	completedBy: SpaceTodoCompletedBy | null;
	createdAt: string;
	updatedAt: string;
};

/** The brief sent to a thread when a todo is assigned to one directly. */
export function todoBrief(todo: Pick<SpaceTodo, 'title' | 'description' | 'sourceUrl'>): string {
	const title = todo.title.trim();
	const description = todo.description.trim();
	const source = todo.sourceUrl?.trim();
	const parts = [description ? `${title}\n\n${description}` : title];
	if (source) parts.push(`Reference: ${source}`);
	return parts.join('\n\n');
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeBody = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

export type TodoAssignMeta = {
	id: string;
	title: string;
	priority?: TodoPriority | null;
	repo?: string | null;
	tags?: string[];
	dueAt?: string | null;
	sourceUrl?: string | null;
	files?: string[];
	description: string;
	note?: string;
};

/** Message sent to the coordinator when the user assigns a todo to it to start right away. */
export function todoAssignMessage(meta: TodoAssignMeta): string {
	const attrs: string[] = [`id="${escapeAttr(meta.id)}"`, `title="${escapeAttr(meta.title)}"`];
	if (meta.priority) attrs.push(`priority="${escapeAttr(meta.priority)}"`);
	if (meta.repo) attrs.push(`repo="${escapeAttr(meta.repo)}"`);
	if (meta.tags?.length) attrs.push(`tags="${escapeAttr(meta.tags.join(', '))}"`);
	if (meta.dueAt) attrs.push(`due="${escapeAttr(meta.dueAt)}"`);
	if (meta.sourceUrl) attrs.push(`source="${escapeAttr(meta.sourceUrl)}"`);
	if (meta.files?.length) attrs.push(`files="${escapeAttr(meta.files.join(', '))}"`);
	const sections: string[] = [];
	if (meta.description.trim()) sections.push(meta.description.trim());
	if (meta.note?.trim()) sections.push(`Note from the user: ${meta.note.trim()}`);
	const content = sections.join('\n\n');
	return content
		? `<todo-assign ${attrs.join(' ')}>\n${escapeBody(content)}\n</todo-assign>`
		: `<todo-assign ${attrs.join(' ')}/>`;
}

export type ParsedTodoAssign = {
	id: string;
	title: string;
	priority: TodoPriority | null;
	repo: string | null;
	tags: string[];
	dueAt: string | null;
	sourceUrl: string | null;
	files: string[];
	body: string;
};

export function parseTodoAssign(text: string): ParsedTodoAssign | null {
	const match = /^\s*<todo-assign ([^>]*?)(?:\/>|>([\s\S]*?)<\/todo-assign>)\s*$/.exec(text);
	if (!match) return null;
	const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, unescapeXml(value)]));
	const priority = (TODO_PRIORITIES as readonly string[]).includes(attrs.priority) ? (attrs.priority as TodoPriority) : null;
	const splitList = (value?: string) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : []);
	return {
		id: attrs.id ?? '',
		title: attrs.title ?? 'To-do',
		priority,
		repo: attrs.repo || null,
		tags: splitList(attrs.tags),
		dueAt: attrs.due || null,
		sourceUrl: attrs.source || null,
		files: splitList(attrs.files),
		body: unescapeXml(match[2] ?? '').trim(),
	};
}

/**
 * Only an authenticated <todo-assign> delivery for this exact coordinator-assigned item may authorize quoted text;
 * a model-supplied todo_id alone only links work after the user-message quote check passes.
 */
export function quoteSourceForTodo(
	userText: string,
	assignedTodo: ParsedTodoAssign | null,
	linkedTodo: Pick<SpaceTodo, 'id' | 'title' | 'description' | 'status' | 'assigneeKind' | 'assignedAt'> | null,
): string {
	const authenticatedAssign = Boolean(
		assignedTodo &&
			linkedTodo &&
			assignedTodo.id === linkedTodo.id &&
			linkedTodo.assigneeKind === 'coordinator' &&
			linkedTodo.assignedAt !== null &&
			(linkedTodo.status === 'triaging' || linkedTodo.status === 'in_progress'),
	);
	return authenticatedAssign && linkedTodo ? [userText, linkedTodo.title, linkedTodo.description].filter(Boolean).join('\n') : userText;
}
