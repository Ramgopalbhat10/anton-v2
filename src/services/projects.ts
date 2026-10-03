import type { McpServer, Project, ProjectSettings } from '../core/types.ts';
import { config } from '../config.ts';
import { announce } from '../core/changes.ts';
import { clearWarmImage, deleteProjectRecord, getProject, listProjects, projectSessionIds, setProjectSettings, upsertProject } from '../db/projects.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { mergeEnv } from './secrets.ts';
import { deleteSession } from './sessions.ts';

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/** An MCP server as the browser sees it: whether it has a token, never the token. */
export type McpServerView = Omit<McpServer, 'auth'> & { hasAuth: boolean };

/**
 * What the browser sees of a repo: variable names and whether servers have
 * tokens, never the secrets; when its prepared image was built, not the image.
 */
export type ProjectView = Omit<Project, 'env' | 'warmImage' | 'mcpServers'> & { envKeys: string[]; mcpServers: McpServerView[] };

function present({ env, warmImage, warmedAt, mcpServers, ...project }: Project): ProjectView {
	return {
		...project,
		warmedAt: warmImage ? warmedAt : null,
		envKeys: Object.keys(env).sort(),
		mcpServers: mcpServers.map(({ auth, ...server }) => ({ ...server, hasAuth: Boolean(auth) })),
	};
}

/** Adds a repository by `owner/name`, checking it exists on the git host. */
export async function addProject(fullName: string): Promise<ProjectView> {
	if (!REPO_NAME.test(fullName)) throw new InvalidInputError('Use the form owner/name');
	const repo = await getProviders().git.getRepo(fullName);
	return present(await upsertProject(repo.fullName, repo.defaultBranch));
}

/** Known repositories; seeds ANTON_DEFAULT_REPO the first time, so removing it later keeps it removed. */
export async function projects(): Promise<ProjectView[]> {
	const known = await listProjects();
	if (known.length > 0 || !config.defaultRepo || (await getSetting('seededDefaultRepo', false))) return known.map(present);
	const seeded = await addProject(config.defaultRepo);
	await setSetting('seededDefaultRepo', true);
	return [seeded];
}

/** Removes a repository and everything Anton keeps for it: its tasks (machines and history too) and its automations. */
export async function removeProject(id: string): Promise<void> {
	await existing(id);
	for (const sessionId of await projectSessionIds(id)) await deleteSession(sessionId);
	await deleteProjectRecord(id);
	announce({ kind: 'sessions' });
}

async function existing(id: string): Promise<Project> {
	const project = await getProject(id);
	if (!project) throw new NotFoundError('Project not found');
	return project;
}

export async function branches(projectId: string): Promise<string[]> {
	return getProviders().git.listBranches((await existing(projectId)).repoFullName);
}

/**
 * A settings change from the browser. A variable set to null keeps its stored
 * value and one left out is removed; a server sent without a token keeps its
 * stored one and an empty token removes it. Leaving out `followUps` or `mcpServers` keeps them as they are.
 */
export type SettingsChange = Omit<ProjectSettings, 'env' | 'followUps' | 'mcpServers'> & {
	env: Record<string, string | null>;
	followUps?: boolean;
	mcpServers?: Array<Omit<McpServer, 'auth'> & { auth?: string | null }>;
};

/**
 * Saves the repo's settings. New tasks use them. Running tasks get variable
 * changes from their next command batch; preview ports and the base image
 * apply once their sandbox restarts.
 */
export async function updateSettings(id: string, change: SettingsChange): Promise<ProjectView> {
	const project = await existing(id);
	const env = mergeEnv(project.env, change.env);
	// A token stays only with the host it was given for, so pointing a server at a new host never sends it there.
	const keyOf = (name: string, url: string) => `${name} ${URL.canParse(url) ? new URL(url).origin : url}`;
	const tokens = new Map(project.mcpServers.map((server) => [keyOf(server.name, server.url), server.auth]));
	const mcpServers = (change.mcpServers ?? project.mcpServers).map(({ name, url, tools, auth }) => ({
		name,
		url,
		tools,
		auth: auth === '' ? null : (auth ?? tokens.get(keyOf(name, url)) ?? null),
	}));
	await setProjectSettings(id, {
		...change,
		env,
		followUps: change.followUps ?? project.followUps,
		mcpServers,
		baseImage: change.baseImage?.trim() || null,
	});
	return present(await existing(id));
}

/** Drops the repo's prepared image, so its next task clones and installs from scratch and saves a new one. */
export async function rebuildPreparedImage(id: string): Promise<ProjectView> {
	await existing(id);
	await clearWarmImage(id);
	return present(await existing(id));
}
