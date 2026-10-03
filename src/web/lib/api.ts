export type SessionStatus = 'starting' | 'running' | 'stopped' | 'error';

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Reasoning = (typeof REASONING_LEVELS)[number];

export type ModelInfo = {
	id: string;
	name: string;
	vendor: string;
	description: string;
	createdAt: number;
	contextLength: number;
	maxOutput: number | null;
	/** US dollars per million tokens. */
	price: { input: number; output: number };
	vision: boolean;
	reasoning: Reasoning[];
	defaultReasoning: Reasoning;
};

/** A task's model and reasoning level; null reasoning runs the model's default. */
export type ModelChoice = { model: string; reasoning: Reasoning | null };

export type Session = {
	id: string;
	projectId: string;
	repo: string;
	title: string;
	model: string;
	reasoning: Reasoning | null;
	branch: string;
	baseBranch: string;
	baseSha: string;
	status: SessionStatus;
	/** The agent is working on a message right now. */
	working: boolean;
	/** The task has had a machine; until then it reads the repo without a sandbox, clone or branch. */
	workspace: boolean;
	/** The agent proposes a plan and changes nothing until it is approved. */
	planMode: boolean;
	prUrl: string | null;
	errorMessage: string | null;
	checkpointAt: string | null;
	createdAt: string;
	/** Model tokens and cost (US dollars) across every finished response. */
	usage: Usage;
};

export type Usage = { inputTokens: number; outputTokens: number; cost: number };

/** A saved prompt, typed as `/name` in the composer. */
export type Command = { name: string; prompt: string };

/** One distinct state of the task's files, newest first in the timeline. */
export type CheckpointSummary = { at: string; files: number; added: number | null; removed: number | null; commit: string | null };

/** Repo settings every new sandbox for it gets. Variable values never leave the server, only their names. */
/** An MCP server the agent can use; its token is never sent back, only whether it has one. */
export type McpServer = { name: string; url: string; tools: string[]; hasAuth: boolean };

export type ProjectSettings = {
	envKeys: string[];
	setupScript: string;
	previewPorts: number[];
	baseImage: string | null;
	/** Whether the agent hears about failed checks and new comments on its pull requests. */
	followUps: boolean;
	mcpServers: McpServer[];
};

export type Project = {
	id: string;
	repoFullName: string;
	defaultBranch: string;
	/** Notes every task's agent reads, one per line. */
	memory: string;
} & ProjectSettings;

/**
 * A settings save: a variable set to null keeps its stored value and one left
 * out is removed; a server's token set to null keeps the stored one and an
 * empty one removes it.
 */
export type SettingsChange = Omit<ProjectSettings, 'envKeys' | 'mcpServers'> & {
	env: Record<string, string | null>;
	mcpServers: Array<Omit<McpServer, 'hasAuth'> & { auth: string | null }>;
};

/** A way tasks start on their own: from issues with a label, or every few hours. */
export type Automation = {
	id: string;
	projectId: string;
	kind: 'issues' | 'schedule';
	label: string | null;
	everyHours: number | null;
	prompt: string;
	model: string | null;
	reasoning: Reasoning | null;
	/** Its tasks start in plan mode and wait for approval. */
	planFirst: boolean;
	enabled: boolean;
	lastRunAt: string | null;
	lastError: string | null;
	seen: number[];
	createdAt: string;
};

export type AutomationInput = Pick<Automation, 'kind' | 'label' | 'everyHours' | 'prompt' | 'model' | 'reasoning' | 'planFirst'>;

/** Where a view's data came from: the running machine, the last checkpoint, or the starting commit. */
export type Source = 'live' | 'saved' | 'base';

export type FileChange = { path: string; status: 'A' | 'M' | 'D' };

export type FilesPayload = { source: Source; at: string | null; paths: string[]; changes: FileChange[] };

export type ChangesPayload = {
	source: Source;
	at: string | null;
	branch: string;
	baseBranch: string;
	patch: string;
	log: Array<{ sha: string; subject: string; at: string }>;
};

export type PullRequest = { url: string; state: 'open' | 'draft' | 'merged' | 'closed' | null };

export type Preview = { port: number; url: string | null; listening: boolean };
export type PreviewsPayload = { live: boolean; previews: Preview[] };

/** Spending caps in US dollars; null means no cap. */
export type Limits = { dailyUsd: number | null; taskUsd: number | null };
export type Budget = { limits: Limits; today: number; task: number | null; blocked: string | null };
export type CleanupResult = { at: string; removed: number; freedBytes: number };
export type StorageView = { objects: number; bytes: number; lastCleanup: CleanupResult | null };

export type Output = { path: string; size: number; mtimeMs: number };
export type OutputsPayload = { source: Source; at: string | null; outputs: Output[] };

async function request(input: string, init?: RequestInit): Promise<Response> {
	const response = await fetch(input, {
		...init,
		headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
	});
	if (!response.ok) {
		const body = await response.text();
		const message = (() => {
			try {
				return (JSON.parse(body) as { error?: string }).error;
			} catch {
				return undefined;
			}
		})();
		throw new Error(message || body || response.statusText);
	}
	return response;
}

const json = async <T,>(input: string, init?: RequestInit) => (await request(input, init)).json() as Promise<T>;
const post = <T,>(input: string, body?: unknown) => json<T>(input, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const outputUrl = (id: string, path: string) => `/api/sessions/${id}/output?path=${encodeURIComponent(path)}`;

export const api = {
	health: () =>
		json<{ ok: boolean; openRouter: boolean; providers: { sandbox: string; store: string; git: string } }>('/api/health'),
	budget: (sessionId?: string) => json<Budget>(`/api/budget${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),
	setLimits: (limits: Limits) => json<Budget>('/api/settings/limits', { method: 'PUT', body: JSON.stringify(limits) }),
	storage: () => json<StorageView>('/api/storage'),
	cleanUpStorage: () => post<CleanupResult>('/api/storage/cleanup'),
	models: () => json<{ models: ModelInfo[]; default: string }>('/api/models'),
	projects: () => json<{ projects: Project[] }>('/api/projects'),
	addProject: (repo: string) => post<Project>('/api/projects', { repo }),
	commands: () => json<{ commands: Command[] }>('/api/settings/commands'),
	saveCommands: (commands: Command[]) =>
		json<{ commands: Command[] }>('/api/settings/commands', { method: 'PUT', body: JSON.stringify({ commands }) }),
	saveMemory: (id: string, memory: string) =>
		json<{ memory: string }>(`/api/projects/${id}/memory`, { method: 'PUT', body: JSON.stringify({ memory }) }),
	updateProjectSettings: (id: string, change: SettingsChange) =>
		json<Project>(`/api/projects/${id}/settings`, { method: 'PUT', body: JSON.stringify(change) }),
	automations: (projectId: string) => json<{ automations: Automation[] }>(`/api/projects/${projectId}/automations`),
	addAutomation: (projectId: string, input: AutomationInput) => post<Automation>(`/api/projects/${projectId}/automations`, input),
	setAutomationEnabled: (id: string, enabled: boolean) =>
		json<Automation>(`/api/automations/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
	runAutomation: (id: string) => post<Automation>(`/api/automations/${id}/run`),
	deleteAutomation: async (id: string) => void (await request(`/api/automations/${id}`, { method: 'DELETE' })),
	branches: (projectId: string) => json<{ branches: string[] }>(`/api/projects/${projectId}/branches`),
	sessions: () => json<{ sessions: Session[] }>('/api/sessions'),
	createSession: (body: { projectId: string; branch?: string; title?: string; model?: string; reasoning?: Reasoning; planMode?: boolean }) =>
		post<Session>('/api/sessions', body),
	session: (id: string) => json<Session>(`/api/sessions/${id}`),
	stopSession: (id: string) => post<Session>(`/api/sessions/${id}/stop`),
	resumeSession: (id: string) => post<Session>(`/api/sessions/${id}/resume`),
	editSession: (id: string, change: Partial<ModelChoice> & { title?: string; planMode?: boolean }) =>
		json<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(change) }),
	deleteSession: async (id: string) => void (await request(`/api/sessions/${id}`, { method: 'DELETE' })),
	checkpoints: (id: string) => json<{ checkpoints: CheckpointSummary[] }>(`/api/sessions/${id}/checkpoints`),
	checkpoint: (id: string, at: string) => json<{ at: string; patch: string | null }>(`/api/sessions/${id}/checkpoints/${encodeURIComponent(at)}`),
	restoreCheckpoint: (id: string, at: string) =>
		post<{ at: string; skipped: string[] }>(`/api/sessions/${id}/checkpoints/${encodeURIComponent(at)}/restore`),
	previews: (id: string) => json<PreviewsPayload>(`/api/sessions/${id}/previews`),
	pullRequest: (id: string) => json<PullRequest | null>(`/api/sessions/${id}/pull-request`),
	/** Stops the agent's current turn and anything queued behind it. */
	stopAgent: async (id: string) => void (await request(`/api/agents/coder/${id}/abort`, { method: 'POST' })),
	changes: (id: string) => json<ChangesPayload>(`/api/sessions/${id}/changes`),
	files: (id: string) => json<FilesPayload>(`/api/sessions/${id}/files`),
	file: async (id: string, path: string) =>
		new Uint8Array(await (await request(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`)).arrayBuffer()),
	outputs: (id: string) => json<OutputsPayload>(`/api/sessions/${id}/outputs`),
	outputText: async (id: string, path: string) => (await request(outputUrl(id, path))).text(),
};

/**
 * Pages refetch when the server says something changed (see live-updates.ts).
 * Polling is only a safety net, for changes nobody announces: a sandbox
 * stopping when idle, or files edited from the terminal.
 */
export const SAFETY_NET_MS = 60_000;

/** A live sandbox can change under the terminal, so its views are checked more often. */
export const refreshFor = (source: Source | undefined) => (source === 'live' ? 15_000 : SAFETY_NET_MS);

/** The branch a task works on, or the one it reads from while it has no workspace. */
export const branchLabel = (session: Session) => (session.workspace ? session.branch : `${session.baseBranch} (read-only)`);
