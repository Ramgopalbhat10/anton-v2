import type { AgentModel } from './types.ts';

/** A project to-do waits in `open`; starting it (a thread, or the coordinator) makes it `in_progress`; its threads resolving make it `done`. */
export const SPACE_TODO_STATUSES = ['open', 'in_progress', 'done'] as const;
export type SpaceTodoStatus = (typeof SPACE_TODO_STATUSES)[number];

/** A file in the project's Library, attached when the to-do was written: it goes with the brief the to-do starts, an image as a picture. */
export type TodoAttachment = { name: string; path: string; kind: string; size: number };

/** As many as a message from the project chat carries to a thread. */
export const MAX_TODO_ATTACHMENTS = 10;
export const MAX_TODO_TITLE = 200;
export const MAX_TODO_DESCRIPTION = 20_000;
export const MAX_TODO_REPOS = 20;

export type SpaceTodo = {
	id: string;
	spaceId: string;
	title: string;
	description: string;
	attachments: TodoAttachment[];
	threadModel: AgentModel | null;
	/** Project repositories (their ids) the user tagged it with: a thread started from it works in each. None lets Anton pick one. */
	repos: string[];
	status: SpaceTodoStatus;
	/** Who took it on: null while open, `coordinator` until it links a thread, `thread` once one works on it. */
	assignee: 'coordinator' | 'thread' | null;
	createdBy: 'user' | 'coordinator';
	/** Linked threads that still exist. */
	threads: number;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
};

/** The brief a thread started from a to-do gets. */
export function todoBrief(todo: Pick<SpaceTodo, 'title' | 'description'>): string {
	const description = todo.description.trim();
	return description ? `${todo.title.trim()}\n\n${description}` : todo.title.trim();
}

/** The short id the coordinator sees in its project state and passes back as todo_id. */
export const shortTodoId = (id: string) => id.replace(/^todo_/, '').slice(0, 8);

export const todoRef = (ref: string) => ref.trim().replace(/^\[|\]$/g, '').replace(/^todo:/, '');

/** Sent to the coordinator as the user's own message, so the request it quotes for a thread is in it word for word. */
export function todoStartMessage(todo: Pick<SpaceTodo, 'id' | 'title' | 'description'>, repos: string[] = []): string {
	const tagged = repos.length ? `\n\nRepositories tagged on this to-do: ${repos.join(', ')}.` : '';
	return `Start the project to-do [todo:${shortTodoId(todo.id)}]: ${todoBrief(todo)}${tagged}`;
}

export const todoHandoffId = (message: string): string | null => /^Start the project to-do \[todo:([a-f0-9]{8})\]: /.exec(message)?.[1] ?? null;

/** The files the coordinator names for a to-do's thread; naming none sends all of the to-do's, so a to-do split over threads gives each only its part's. */
export const todoThreadFiles = (todo: Pick<SpaceTodo, 'attachments'> | null, listed?: string[]): string[] | undefined =>
	listed?.length || !todo?.attachments.length ? listed : todo.attachments.map((file) => file.path);
