import { type QueryClient, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { SpaceTodo, TodoAttachment } from '@/lib/api/spaces';
import { uniqueUploadNames } from '../../../core/upload-name';

/** What the to-do dialog hands over: files already in the Library, and new ones still to upload. */
export type TodoDraft = { title: string; description: string; threadModel: SpaceTodo['threadModel']; repos: string[]; kept: TodoAttachment[]; uploads: File[] };

/** How a card stands against the server: still saving, or failed with a way to try again. */
export type TodoSave = { pending: boolean; saving: boolean; error: string | null; retry?: () => void; dismiss?: () => void };

export const todoIsUnsaved = (save: TodoSave | undefined) => Boolean(save?.pending || save?.saving);
export const canStartTodo = (todo: SpaceTodo, save: TodoSave | undefined) => todo.status === 'open' && !todoIsUnsaved(save);
export const todoThreadStartKey = (spaceId: string) => ['space-todo-thread-start', spaceId] as const;

/** Neither start button should see the old open status between a successful start and the board's refetch. */
export function cacheStartedTodo(queryClient: QueryClient, spaceId: string, todo: SpaceTodo | undefined) {
	if (!todo) return;
	queryClient.setQueryData<{ todos: SpaceTodo[] }>(['space-todos', spaceId], (previous) => previous && {
		...previous,
		todos: previous.todos.map((item) => item.id === todo.id && item.updatedAt <= todo.updatedAt ? todo : item),
	});
}

type Change = Partial<Pick<SpaceTodo, 'title' | 'description' | 'attachments' | 'threadModel' | 'repos' | 'status' | 'assignee' | 'completedAt'>>;
type Created = { key: string; todo: SpaceTodo; draft: TodoDraft; error: string | null; saved: SpaceTodo | null };
/** `savedAt` is the server's updatedAt once it has the change; the override gives way when the list has caught up. */
type Edited = { seq: number; change: Change; hidden: boolean; savedAt: string | null };
type Failed = { message: string; retry: () => void };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'Could not save');

/** New files go to the Library once; a retry after a failed save reuses what already went up. */
async function uploadDraft(spaceId: string, draft: TodoDraft): Promise<TodoAttachment[]> {
	if (!draft.uploads.length) return draft.kept;
	const taken = draft.kept.map((file) => file.name);
	const names = uniqueUploadNames([...taken, ...draft.uploads.map((file) => file.name)]).slice(taken.length);
	const named = draft.uploads.map((file, index) => (file.name === names[index] ? file : new File([file], names[index]!, { type: file.type, lastModified: file.lastModified })));
	const attached = await Promise.all(named.map((file) => api.attachToProject(spaceId, file)));
	draft.kept = [...draft.kept, ...attached.map(({ name, path, kind, size }) => ({ name, path, kind, size }))];
	draft.uploads = [];
	return draft.kept;
}

/** Until uploaded, a new file shows by its name with no Library path. */
const shownFiles = (draft: TodoDraft): TodoAttachment[] => [...draft.kept, ...draft.uploads.map((file) => ({ name: file.name, path: '', kind: file.type || 'File', size: file.size }))];

const without = <T>(record: Record<string, T>, id: string): Record<string, T> => {
	if (!(id in record)) return record;
	const { [id]: _gone, ...rest } = record;
	return rest;
};

/**
 * Creates, edits, status changes and deletes show on the board at once and save in the background. The board draws
 * the server's list with these laid over it, so a refetch landing mid-save neither drops nor doubles a card.
 */
export function useTodoSaves(spaceId: string, serverTodos: SpaceTodo[]) {
	const queryClient = useQueryClient();
	const threadStarts = useMutationState({
		filters: { mutationKey: todoThreadStartKey(spaceId), status: 'pending' },
		select: (mutation) => mutation.options.mutationKey?.[2],
	});
	const [created, setCreated] = useState<Created[]>([]);
	const [edited, setEdited] = useState<Record<string, Edited>>({});
	const [failed, setFailed] = useState<Record<string, Failed>>({});
	const seq = useRef(0);

	const settle = (update: (todos: SpaceTodo[]) => SpaceTodo[]) =>
		queryClient.setQueryData<{ todos: SpaceTodo[] }>(['space-todos', spaceId], (old) => (old ? { ...old, todos: update(old.todos) } : old));

	const runCreate = (key: string, draft: TodoDraft) => {
		setCreated((list) => list.map((item) => (item.key === key ? { ...item, error: null } : item)));
		void (async () => {
			try {
				const attachments = await uploadDraft(spaceId, draft);
				const todo = await api.createSpaceTodo(spaceId, { title: draft.title, description: draft.description, attachments, threadModel: draft.threadModel, repos: draft.repos });
				settle((todos) => (todos.some((other) => other.id === todo.id) ? todos : [...todos, todo]));
				setCreated((list) => list.map((item) => (item.key === key ? { ...item, saved: todo } : item)));
			} catch (error) {
				setCreated((list) => list.map((item) => (item.key === key ? { ...item, error: messageOf(error) } : item)));
			}
		})();
	};

	const create = (draft: TodoDraft) => {
		const key = `pending_${++seq.current}`;
		const now = new Date().toISOString();
		const todo: SpaceTodo = {
			id: key,
			spaceId,
			title: draft.title.trim(),
			description: draft.description.trim(),
			attachments: shownFiles(draft),
			threadModel: draft.threadModel,
			repos: draft.repos,
			status: 'open',
			assignee: null,
			createdBy: 'user',
			threads: 0,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		};
		setCreated((list) => [...list, { key, todo, draft, error: null, saved: null }]);
		runCreate(key, draft);
	};

	/** Lays `change` over the card now and sends `send` for it; a failure puts the card back and offers to try again. */
	const run = (todo: SpaceTodo, change: Change, send: () => Promise<SpaceTodo | null>, hidden = false) => {
		const n = ++seq.current;
		setFailed((all) => without(all, todo.id));
		setEdited((all) => ({ ...all, [todo.id]: { seq: n, change: { ...all[todo.id]?.change, ...change }, hidden: hidden || Boolean(all[todo.id]?.hidden), savedAt: null } }));
		void send().then(
			(saved) => {
				settle((todos) => (saved ? todos.map((other) => (other.id === saved.id ? saved : other)) : todos.filter((other) => other.id !== todo.id)));
				setEdited((all) => (all[todo.id]?.seq === n ? { ...all, [todo.id]: { ...all[todo.id]!, savedAt: saved?.updatedAt ?? '' } } : all));
			},
			(error: unknown) => {
				setEdited((all) => (all[todo.id]?.seq === n ? without(all, todo.id) : all));
				setFailed((all) => ({ ...all, [todo.id]: { message: messageOf(error), retry: () => run(todo, change, send, hidden) } }));
			},
		);
	};

	const edit = (todo: SpaceTodo, draft: TodoDraft) => {
		const before = todo.threadModel;
		const after = draft.threadModel;
		const modelChange = before?.model === after?.model && before?.reasoning === after?.reasoning ? {} : { threadModel: after };
		const repoChange = todo.repos.join() === draft.repos.join() ? {} : { repos: draft.repos };
		run(todo, { title: draft.title.trim(), description: draft.description.trim(), attachments: shownFiles(draft), ...modelChange, ...repoChange }, async () => {
			const attachments = await uploadDraft(spaceId, draft);
			return api.editSpaceTodo(spaceId, todo.id, { title: draft.title, description: draft.description, attachments, ...modelChange, ...repoChange });
		});
	};

	/** Set back to open, a to-do leaves whoever had it, as the server does. */
	const setStatus = (todo: SpaceTodo, status: 'open' | 'done') =>
		run(todo, status === 'open' ? { status, assignee: null, completedAt: null } : { status, completedAt: new Date().toISOString() }, () => api.editSpaceTodo(spaceId, todo.id, { status }));

	const remove = (todo: SpaceTodo) =>
		run(
			todo,
			{},
			async () => {
				await api.deleteSpaceTodo(spaceId, todo.id);
				return null;
			},
			true,
		);

	const todos = useMemo(() => {
		const shown: SpaceTodo[] = [];
		for (const todo of serverTodos) {
			const over = edited[todo.id];
			if (over?.hidden) continue;
			shown.push(over && !(over.savedAt !== null && todo.updatedAt >= over.savedAt) ? { ...todo, ...over.change } : todo);
		}
		const ids = new Set(serverTodos.map((todo) => todo.id));
		for (const item of created) if (!(item.saved && ids.has(item.saved.id))) shown.push(item.saved ?? item.todo);
		return shown;
	}, [serverTodos, edited, created]);

	// Drop what the server's list now shows for itself.
	useEffect(() => {
		const byId = new Map(serverTodos.map((todo) => [todo.id, todo]));
		setCreated((list) => (list.some((item) => item.saved && byId.has(item.saved.id)) ? list.filter((item) => !(item.saved && byId.has(item.saved.id))) : list));
		setEdited((all) => {
			const done = Object.entries(all).filter(([id, over]) => {
				if (over.savedAt === null) return false;
				const todo = byId.get(id);
				return over.hidden ? !todo : !todo || todo.updatedAt >= over.savedAt;
			});
			return done.length ? done.reduce((rest, [id]) => without(rest, id), all) : all;
		});
	}, [serverTodos]);

	const stateOf = (todo: SpaceTodo): TodoSave | undefined => {
		const item = created.find((other) => other.key === todo.id || other.saved?.id === todo.id);
		if (item && !item.saved) {
			return {
				pending: true,
				saving: item.error === null,
				error: item.error,
				retry: () => runCreate(item.key, item.draft),
				dismiss: () => setCreated((list) => list.filter((other) => other.key !== item.key)),
			};
		}
		const failure = failed[todo.id];
		if (failure) return { pending: false, saving: false, error: failure.message, retry: failure.retry, dismiss: () => setFailed((all) => without(all, todo.id)) };
		const over = edited[todo.id];
		if (over && over.savedAt === null) return { pending: false, saving: true, error: null };
		return undefined;
	};

	return { todos, create, edit, setStatus, remove, stateOf, isStartingThread: (id: string) => threadStarts.includes(id) };
}

export type TodoSaves = ReturnType<typeof useTodoSaves>;
