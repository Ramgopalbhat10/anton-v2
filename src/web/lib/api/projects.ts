import type { Schedule } from '../../../core/schedule';
import { json, post, request } from './http';
import type { Reasoning } from './plans';

/** Variable values never leave the server, only their names. */
export type ProjectSettings = {
	envKeys: string[];
	setupScript: string;
	/** Run in the task's sandbox after the agent changes files; the agent hears of it only when it fails. Empty runs none. */
	checkCommand: string;
	previewPorts: number[];
	baseImage: string | null;
	followUps: boolean;
	/** Whether Anton reviews the pull requests people open on the repo, and again after their pushes. */
	reviewOthers: boolean;
	/** Tasks run in a full virtual machine (Docker, FUSE, their own kernel) rather than a container. */
	fullVm: boolean;
};

export type Project = {
	id: string;
	repoFullName: string;
	defaultBranch: string;
	memory: string;
	/** When the image new tasks start from (repo cloned, dependencies installed) was built. */
	warmedAt: string | null;
} & ProjectSettings;

/** A settings save: a variable set to null keeps its stored value and one left out is removed. */
export type SettingsChange = Omit<ProjectSettings, 'envKeys'> & {
	env: Record<string, string | null>;
};

export type Automation = {
	id: string;
	projectId: string;
	kind: 'issues' | 'schedule';
	label: string | null;
	/** When it runs (kind `schedule`), on its time zone's clock. */
	schedule: Schedule | null;
	/** When a schedule runs next; null until the server works it out. */
	nextRunAt: string | null;
	prompt: string;
	model: string | null;
	reasoning: Reasoning | null;
	planFirst: boolean;
	enabled: boolean;
	lastRunAt: string | null;
	lastError: string | null;
	seen: number[];
	spaceId?: string | null;
	/** A short name for what a schedule does, its runs' title; null until its first run names it. */
	title?: string | null;
	/** A skill's script that says whether a due run starts a thread, as `skill-name/scripts/file.js`. */
	gate?: string | null;
	lastGate?: { at: string; run: boolean; reason: string } | null;
	createdAt: string;
};

export type AutomationInput = Pick<Automation, 'kind' | 'label' | 'schedule' | 'prompt' | 'model' | 'reasoning' | 'planFirst'> & { spaceId?: string | null; gate?: string | null };

export const projectsApi = {
	rebuildPreparedImage: (projectId: string) => post<Project>(`/api/projects/${projectId}/prepared-image/rebuild`),
	projects: () => json<{ projects: Project[] }>('/api/projects'),
	addableRepos: () => json<{ repos: string[] }>('/api/repos'),
	addProject: (repo: string) => post<Project>('/api/projects', { repo }),
	removeProject: async (id: string) => void (await request(`/api/projects/${id}`, { method: 'DELETE' })),
	saveMemory: (id: string, memory: string) =>
		json<{ memory: string }>(`/api/projects/${id}/memory`, { method: 'PUT', body: JSON.stringify({ memory }) }),
	updateProjectSettings: (id: string, change: SettingsChange) =>
		json<Project>(`/api/projects/${id}/settings`, { method: 'PUT', body: JSON.stringify(change) }),
	automations: (projectId: string) => json<{ automations: Automation[] }>(`/api/projects/${projectId}/automations`),
	addAutomation: (projectId: string, input: AutomationInput) => post<Automation>(`/api/projects/${projectId}/automations`, input),
	setAutomationEnabled: (id: string, enabled: boolean) =>
		json<Automation>(`/api/automations/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
	/** Changes what an automation does; `projectId` picks a project routine's repository (null for chats). */
	editAutomation: (id: string, input: Omit<AutomationInput, 'spaceId'> & { projectId?: string | null }) =>
		json<Automation>(`/api/automations/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
	runAutomation: (id: string) => post<Automation>(`/api/automations/${id}/run`),
	deleteAutomation: async (id: string) => void (await request(`/api/automations/${id}`, { method: 'DELETE' })),
	branches: (projectId: string) => json<{ branches: string[] }>(`/api/projects/${projectId}/branches`),
	projectFiles: (projectId: string, branch?: string) =>
		json<{ paths: string[] }>(`/api/projects/${projectId}/files${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`),
};
