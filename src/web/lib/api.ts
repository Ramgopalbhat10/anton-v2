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
	prUrl: string | null;
	errorMessage: string | null;
	checkpointAt: string | null;
	createdAt: string;
};

export type Project = {
	id: string;
	repoFullName: string;
	defaultBranch: string;
};

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
	models: () => json<{ models: ModelInfo[]; default: string }>('/api/models'),
	projects: () => json<{ projects: Project[] }>('/api/projects'),
	addProject: (repo: string) => post<Project>('/api/projects', { repo }),
	branches: (projectId: string) => json<{ branches: string[] }>(`/api/projects/${projectId}/branches`),
	sessions: () => json<{ sessions: Session[] }>('/api/sessions'),
	createSession: (body: { projectId: string; branch?: string; title?: string; model?: string; reasoning?: Reasoning }) =>
		post<Session>('/api/sessions', body),
	session: (id: string) => json<Session>(`/api/sessions/${id}`),
	stopSession: (id: string) => post<Session>(`/api/sessions/${id}/stop`),
	resumeSession: (id: string) => post<Session>(`/api/sessions/${id}/resume`),
	setModel: (id: string, change: Partial<ModelChoice>) =>
		json<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(change) }),
	changes: (id: string) => json<ChangesPayload>(`/api/sessions/${id}/changes`),
	files: (id: string) => json<FilesPayload>(`/api/sessions/${id}/files`),
	file: async (id: string, path: string) =>
		new Uint8Array(await (await request(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`)).arrayBuffer()),
	outputs: (id: string) => json<OutputsPayload>(`/api/sessions/${id}/outputs`),
	outputText: async (id: string, path: string) => (await request(outputUrl(id, path))).text(),
};

/** Live views refresh often; saved and base views only change when the machine starts. */
export const refreshFor = (source: Source | undefined) => (source === 'live' ? 4000 : 15000);
