import type { McpServer, Project, ProjectSettings } from '../core/types.ts';
import { config } from '../config.ts';
import { getProject, listProjects, setProjectSettings, upsertProject } from '../db/projects.ts';
import { getProviders } from '../providers/index.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/** An MCP server as the browser sees it: whether it has a token, never the token. */
export type McpServerView = Omit<McpServer, 'auth'> & { hasAuth: boolean };

/** What the browser sees of a repo: variable names and whether servers have tokens, never the secrets. */
export type ProjectView = Omit<Project, 'env' | 'warmImage' | 'warmedAt' | 'mcpServers'> & { envKeys: string[]; mcpServers: McpServerView[] };

function present({ env, warmImage: _image, warmedAt: _at, mcpServers, ...project }: Project): ProjectView {
	return {
		...project,
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

/** Known repositories; seeds ANTON_DEFAULT_REPO the first time. */
export async function projects(): Promise<ProjectView[]> {
	const known = await listProjects();
	if (known.length > 0 || !config.defaultRepo) return known.map(present);
	return [await addProject(config.defaultRepo)];
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

/** Saves the repo's settings. New tasks use them; running tasks keep theirs until their sandbox restarts. */
export async function updateSettings(id: string, change: SettingsChange): Promise<ProjectView> {
	const project = await existing(id);
	const env = Object.fromEntries(
		Object.entries(change.env)
			.map(([key, value]) => [key, value ?? project.env[key]] as const)
			.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
	);
	const tokens = new Map(project.mcpServers.map((server) => [server.name, server.auth]));
	const mcpServers = (change.mcpServers ?? project.mcpServers).map(({ name, url, tools, auth }) => ({
		name,
		url,
		tools,
		auth: auth === '' ? null : (auth ?? tokens.get(name) ?? null),
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
