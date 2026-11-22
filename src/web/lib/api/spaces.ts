import type { AttachedFile } from '../../../core/attachments';
import type { SpaceTodo, SpaceTodoStatus, TodoPriority } from '../../../core/space-todos';
import { json, post, request } from './http';
import type { Reasoning } from './plans';
import type { Automation, AutomationInput } from './projects';
import type { Session } from './sessions';
import type { HelperAgent } from './settings';

export type { SpaceTodo, SpaceTodoStatus, TodoPriority };

/** In the order a project lists its threads. */
export const THREAD_STATES = ['waiting', 'working', 'queued', 'review', 'landing', 'idle', 'resolved'] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export type Autonomy = 'start' | 'propose';
export type SpaceState = 'active' | 'paused' | 'archived';

/** A project: a coordinator conversation over parallel threads, each a task on one of its repositories. */
export type Space = {
	id: string;
	name: string;
	icon: string | null;
	goal: string;
	instructions: string;
	memory: string;
	coordinatorModel: string | null;
	coordinatorReasoning: Reasoning | null;
	threadModel: string | null;
	threadReasoning: Reasoning | null;
	agentModels: Record<HelperAgent, { model: string; reasoning: Reasoning | null } | null>;
	maxParallel: number;
	autonomy: Autonomy;
	state: SpaceState;
	repoIds: string[];
	repos: Array<{ id: string; repoFullName: string; defaultBranch: string }>;
	counts: Record<ThreadState, number>;
	threads: number;
	activeAt: string;
	createdAt: string;
	updatedAt: string;
};

export type SpaceInput = { name: string; icon?: string | null; goal?: string; repoIds?: string[]; instructions?: string; autonomy?: Autonomy; maxParallel?: number };
export type SpaceChange = Partial<
	Pick<Space, 'name' | 'icon' | 'goal' | 'instructions' | 'memory' | 'coordinatorModel' | 'coordinatorReasoning' | 'threadModel' | 'threadReasoning' | 'agentModels' | 'maxParallel' | 'autonomy' | 'state' | 'repoIds'>
>;
/** `projectId` null starts a thread with no repository, a chat. */
export type ThreadInput = { id?: string; title?: string; brief: string; projectId?: string | null; repo?: string; model?: string; reasoning?: Reasoning; planMode?: boolean };
export type SpaceFile = { path: string; size: number; modifiedAt: string };
export type SpaceUsage = {
	today: number;
	month: number;
	byThread: Array<{ id: string; title: string; tokens: number; cost: number }>;
	byModel: Array<{ key: string | null; tokens: number; cost: number }>;
	daily: Array<{ day: string; tokens: number; cost: number }>;
};

export type CreateSpaceTodoInput = {
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
};

export type EditSpaceTodoInput = Partial<CreateSpaceTodoInput> & {
	status?: SpaceTodoStatus;
};

export type AssignSpaceTodoInput =
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

export const spacesApi = {
	spaces: () => json<{ spaces: Space[] }>('/api/spaces'),
	space: (id: string) => json<Space>(`/api/spaces/${id}`),
	createSpace: (input: SpaceInput) => post<Space>('/api/spaces', input),
	editSpace: (id: string, change: SpaceChange) => json<Space>(`/api/spaces/${id}`, { method: 'PATCH', body: JSON.stringify(change) }),
	deleteSpace: async (id: string) => void (await request(`/api/spaces/${id}`, { method: 'DELETE' })),
	startThread: (id: string, input: ThreadInput) => post<Session>(`/api/spaces/${id}/threads`, input),
	nudgeThread: (id: string, threadId: string, text: string) => post<Session>(`/api/spaces/${id}/threads/${threadId}/nudge`, { text }),
	spaceTodos: (id: string) => json<{ todos: SpaceTodo[] }>(`/api/spaces/${id}/todos`),
	createSpaceTodo: (id: string, input: CreateSpaceTodoInput) => post<SpaceTodo>(`/api/spaces/${id}/todos`, input),
	editSpaceTodo: (id: string, todoId: string, change: EditSpaceTodoInput) =>
		json<SpaceTodo>(`/api/spaces/${id}/todos/${todoId}`, { method: 'PATCH', body: JSON.stringify(change) }),
	deleteSpaceTodo: async (id: string, todoId: string) => void (await request(`/api/spaces/${id}/todos/${todoId}`, { method: 'DELETE' })),
	reorderSpaceTodos: (id: string, ids: string[]) => post<{ todos: SpaceTodo[] }>(`/api/spaces/${id}/todos/reorder`, { ids }),
	assignSpaceTodo: (id: string, todoId: string, input: AssignSpaceTodoInput) =>
		post<{ todo: SpaceTodo; thread?: Session }>(`/api/spaces/${id}/todos/${todoId}/assign`, input),
	spaceUsage: (id: string) => json<SpaceUsage>(`/api/spaces/${id}/usage`),
	spaceAutomations: (id: string) => json<{ automations: Automation[] }>(`/api/spaces/${id}/automations`),
	/** A routine of the project: on one of its repositories, or with `projectId` null on none, starting chats. */
	addSpaceAutomation: (id: string, input: AutomationInput & { projectId: string | null }) => post<Automation>(`/api/spaces/${id}/automations`, input),
	spaceFiles: (id: string) => json<{ files: SpaceFile[] }>(`/api/spaces/${id}/files`),
	uploadSpaceFile: (id: string, file: File) =>
		json<SpaceFile>(`/api/spaces/${id}/files?name=${encodeURIComponent(file.name)}`, {
			method: 'POST',
			body: file,
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
		}),
	attachToProject: (id: string, file: File) =>
		json<AttachedFile>(`/api/spaces/${id}/attachments?name=${encodeURIComponent(file.name)}`, {
			method: 'POST',
			body: file,
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
		}),
	deleteSpaceFile: async (id: string, path: string) => void (await request(spaceFileUrl(id, path), { method: 'DELETE' })),
	spaceFileText: async (id: string, path: string) => (await request(spaceFileUrl(id, path))).text(),
	stopCoordinator: async (id: string) => void (await request(`/api/agents/coordinator/${id}/abort`, { method: 'POST' })),
};

export const spaceFileUrl = (id: string, path: string) => `/api/spaces/${id}/file?path=${encodeURIComponent(path)}`;
