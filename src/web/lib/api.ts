export type Session = {
	id: string;
	projectId: string;
	flueConversationId: string;
	sandboxId: string | null;
	status: 'starting' | 'running' | 'error' | 'stopped';
	model: string;
	prUrl: string | null;
	errorMessage: string | null;
	createdAt: string;
	title: string;
};

export type Project = {
	id: string;
	repoFullName: string;
	defaultBranch: string;
	workspacePath: string;
};

export type GitPayload = {
	repo: string;
	branch: string;
	upstream: string | null;
	ahead: number;
	behind: number;
	patch: string;
	log: Array<{ sha: string; subject: string; at: string }>;
};

async function json<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
	const response = await fetch(input, {
		...init,
		headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(body || response.statusText);
	}
	return response.json() as Promise<T>;
}

export const api = {
	health: () => json<{ ok: boolean; openRouter: boolean }>('/api/health'),
	models: () => json<{ models: Array<{ id: string; label: string }> }>('/api/models'),
	sessions: () => json<{ sessions: Session[]; project: Project }>('/api/sessions'),
	createSession: (body?: { title?: string; model?: string }) =>
		json<Session>('/api/sessions', { method: 'POST', body: JSON.stringify(body ?? {}) }),
	session: (id: string) => json<{ session: Session; project: Project }>(`/api/sessions/${id}`),
	stopSession: (id: string) => json<Session>(`/api/sessions/${id}/stop`, { method: 'POST' }),
	setModel: (id: string, model: string) =>
		json<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ model }) }),
	git: (id: string) => json<GitPayload>(`/api/vm/${id}/git`),
	files: (id: string) => json<{ cwd: string; paths: string[] }>(`/api/vm/${id}/fs`),
	file: (id: string, path: string) =>
		json<{ path: string; contents: string }>(`/api/vm/${id}/file?path=${encodeURIComponent(path)}`),
};
