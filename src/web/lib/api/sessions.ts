import type { AgentNow } from '../../../core/agent-now';
import type { ModelRoute } from '../../../core/model-route';
import type { Trace } from '../../../core/trace';
import { withStarting } from '../starting';
import { json, post, request } from './http';
import type { ModelChoice, Reasoning } from './plans';
import type { ThreadState } from './spaces';

export type SessionStatus = 'starting' | 'running' | 'stopped' | 'error';

export type RunOn = 'sandbox' | 'host';

export type Session = {
	id: string;
	/** Null for a chat. */
	projectId: string | null;
	/** `owner/name`; empty for a chat. */
	repo: string;
	title: string;
	model: string;
	reasoning: Reasoning | null;
	/** Where the gateway sends the task's calls: one provider first, or a sort; null leaves it to the gateway. Missing from older servers. */
	route?: ModelRoute | null;
	branch: string;
	baseBranch: string;
	baseSha: string;
	status: SessionStatus;
	working: boolean;
	/** The task has had a machine; until then it reads the repo without a sandbox, clone or branch. */
	workspace: boolean;
	planMode: boolean;
	/** Where its commands run: its sandbox, or `host`, the server Anton runs on. Missing from older servers. */
	runOn?: RunOn;
	prUrl: string | null;
	errorMessage: string | null;
	checkpointAt: string | null;
	createdAt: string;
	pinnedAt: string | null;
	/** Its pull request as last read from GitHub; `checks` sums up the head commit's checks. */
	pullRequest: {
		state: 'open' | 'draft' | 'merged' | 'closed';
		checks: 'passed' | 'failed' | 'pending' | null;
		runs: Array<{ name: string; status: 'pending' | 'passed' | 'failed'; url: string }>;
		/** Approved on GitHub and not changed since. */
		approved?: boolean;
		conflicts?: boolean;
	} | null;
	usage: Usage;
	/** The latest message the task was given (by you, a follow-up or an automation); null for older tasks. */
	lastInput?: string | null;
	lastInputAt?: string | null;
	/** What the agent's last reply asks you, until you send a message. */
	asking?: string | null;
	plan?: string | null;
	/** The project the task is a thread of; null for a task of its own. */
	spaceId?: string | null;
	threadState?: ThreadState | null;
	resolvedAt?: string | null;
	/** The brief a queued thread starts with once a slot frees. */
	brief?: string | null;
	/** The start of the thread's latest reply. */
	lastReply?: string | null;
	/** Someone else's pull request (`prUrl`) the task reviews; null for a task doing its own work. */
	review?: { number: number; author: string; trusted: boolean; reviewedHead: string | null; automatic: boolean } | null;
	automationId?: string | null;
};

/** `inputTokens` counts every input token, cached ones too; `cachedTokens` is the part read from the provider's cache. */
export type Usage = { inputTokens: number; outputTokens: number; cost: number; cachedTokens?: number };
export type UsagePart = Usage & { calls: number };

export type CheckpointSummary = { at: string; files: number; added: number | null; removed: number | null; commit: string | null };

export type ContextPart = 'messages' | 'tools' | 'systemPrompt' | 'skills' | 'mcpTools';
export type ContextView = {
	model: string | null;
	window: number;
	used: number;
	/** Where the agent compacts older turns: the window less room kept for the next reply. */
	autocompactAt: number;
	parts: Array<{ key: ContextPart; tokens: number }>;
	at: string | null;
	/** Every model call the task made and the tokens they processed in all; each call re-reads the conversation, so this outgrows `used`. */
	task?: { calls: number; tokens: number };
};

export type ScriptCall = { tool: string; input: string; state: 'running' | 'done' | 'failed'; durationMs: number | null };
export type StepDetail = { outcome: string | null; actions: Array<{ what: string; p: number | null; failed?: boolean }>; decisions: number; cost: number; script?: boolean };
export type SubagentStep = { id: string; tool: string; input: unknown; state: 'running' | 'done' | 'failed'; at: string; durationMs: number | null; detail?: StepDetail };
/** Each list the agent writes replaces the last. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type Todo = { content: string; status: TodoStatus; evidence?: string };
export type TodoList = { todos: Todo[]; updatedAt: string };

/** Where the agent read a message sent while it worked: after which tool call, and whether the reply had already said its last words. */
export type Join = { text: string; afterTool: string; final: boolean; at: string };
/** A message the agent has not read yet, by the runtime's submission id. */
export type WaitingMessage = { id: string; text: string; at: string };
export type { AgentNow };

export type SubagentRun = {
	id: string;
	agent: string;
	prompt: string;
	description: string | null;
	toolCallId: string | null;
	/** Stopped: the user stopped it, alone or with the whole reply. */
	status: 'running' | 'done' | 'failed' | 'stopped';
	startedAt: string;
	durationMs: number | null;
	model: string | null;
	tokens: number;
	calls: number;
	steps: SubagentStep[];
	writing: string | null;
	result: string | null;
};

export const sessionsApi = {
	/** Wakes a sandbox for a new task while it is typed, under the id the task will have; asked again while the draft stays. */
	wakeDraft: (projectId: string, taskId: string, branch?: string) => post<{ waking: boolean }>(`/api/projects/${projectId}/wake`, { taskId, ...(branch ? { branch } : {}) }),
	releaseDraft: (taskId: string) => json<{ released: boolean }>(`/api/drafts/${taskId}/wake`, { method: 'DELETE', keepalive: true }),
	wakeSession: (id: string) => post<{ waking: boolean }>(`/api/sessions/${id}/wake`),
	// Tasks still being made are listed too, as the server lists them only once made.
	sessions: async () => {
		const data = await json<{ sessions: Session[] }>('/api/sessions');
		return { ...data, sessions: withStarting(data.sessions) };
	},
	/** `titleFrom` is the first message: a fast model names the task from it in a moment, in place of `title`. */
	createSession: (body: { id?: string; projectId?: string; branch?: string; title?: string; titleFrom?: string; model?: string; reasoning?: Reasoning; route?: ModelRoute | null; planMode?: boolean; runOn?: RunOn }) =>
		post<Session>('/api/sessions', body),
	session: (id: string) => json<Session>(`/api/sessions/${id}`),
	stopSession: (id: string) => post<Session>(`/api/sessions/${id}/stop`),
	resumeSession: (id: string) => post<Session>(`/api/sessions/${id}/resume`),
	forkSession: (id: string) => post<Session>(`/api/sessions/${id}/fork`),
	/** The default model a failed reply can run again on; null when the task already runs on it. */
	fallbackModel: (id: string) => json<{ fallback: { model: string; name: string } | null }>(`/api/sessions/${id}/fallback`),
	switchToFallbackModel: (id: string) => post<Session>(`/api/sessions/${id}/fallback`),
	editSession: (id: string, change: Partial<ModelChoice> & { route?: ModelRoute | null; title?: string; planMode?: boolean; pinned?: boolean; resolved?: boolean; spaceId?: string | null; runOn?: RunOn }) =>
		json<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(change) }),
	deleteSession: async (id: string) => void (await request(`/api/sessions/${id}`, { method: 'DELETE' })),
	checkpoints: (id: string) => json<{ checkpoints: CheckpointSummary[] }>(`/api/sessions/${id}/checkpoints`),
	checkpoint: (id: string, at: string) => json<{ at: string; patch: string | null }>(`/api/sessions/${id}/checkpoints/${encodeURIComponent(at)}`),
	restoreCheckpoint: (id: string, at: string) =>
		post<{ at: string; skipped: string[] }>(`/api/sessions/${id}/checkpoints/${encodeURIComponent(at)}/restore`),
	context: (id: string) => json<ContextView>(`/api/sessions/${id}/context`),
	subagents: (id: string) => json<{ runs: SubagentRun[] }>(`/api/sessions/${id}/subagents`),
	trace: (id: string, traceId: string) => json<Trace>(`/api/sessions/${id}/traces/${encodeURIComponent(traceId)}`),
	/** Stops one running subagent; the agent is told what it had done and carries on. */
	stopSubagent: async (id: string, runId: string) => void (await post(`/api/sessions/${id}/subagents/${encodeURIComponent(runId)}/stop`)),
	scripts: (id: string) => json<{ scripts: Record<string, ScriptCall[]> }>(`/api/sessions/${id}/scripts`),
	todos: (id: string) => json<{ list: TodoList | null }>(`/api/sessions/${id}/todos`),
	joins: (id: string) => json<{ joins: Join[] }>(`/api/sessions/${id}/joins`),
	waiting: (id: string) => json<{ messages: WaitingMessage[] }>(`/api/sessions/${id}/waiting`),
	now: (id: string) => json<{ now: AgentNow | null }>(`/api/sessions/${id}/now`),
	/** Stops the agent's current turn and anything queued behind it. */
	stopAgent: async (id: string) => void (await request(`/api/agents/coder/${id}/abort`, { method: 'POST' })),
};

/** A chat: a task with no repository, which answers, browses and uses a scratch sandbox. */
export const isChat = (session: Pick<Session, 'projectId'>) => session.projectId === null;

/** The branch a task works on, or the one it reads from while it has no workspace; a chat's scratch sandbox has neither. */
export const branchLabel = (session: Session) =>
	isChat(session) ? (session.workspace ? 'scratch sandbox' : 'no sandbox') : session.workspace ? session.branch : `${session.baseBranch} (read-only)`;

export const repoShort = (session: Pick<Session, 'projectId' | 'repo'>) => (isChat(session) ? 'Chat' : (session.repo.split('/').pop() ?? session.repo));

export const placeLabel = (session: Session) => `${isChat(session) ? 'Chat' : session.repo} · ${branchLabel(session)}`;
