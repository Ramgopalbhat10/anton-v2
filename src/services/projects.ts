import type { Project, ProjectSettings } from '../core/types.ts';
import { config } from '../config.ts';
import { getProject, listProjects, setProjectSettings, upsertProject } from '../db/projects.ts';
import { getProviders } from '../providers/index.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/** What the browser sees of a repo: variable names, never their values. */
export type ProjectView = Omit<Project, 'env' | 'warmImage' | 'warmedAt'> & { envKeys: string[] };

function present({ env, warmImage: _image, warmedAt: _at, ...project }: Project): ProjectView {
	return { ...project, envKeys: Object.keys(env).sort() };
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

/** A settings change from the browser: a variable set to null keeps its stored value; one left out is removed. */
export type SettingsChange = Omit<ProjectSettings, 'env'> & { env: Record<string, string | null> };

/** Saves the repo's settings. New tasks use them; running tasks keep theirs until their sandbox restarts. */
export async function updateSettings(id: string, change: SettingsChange): Promise<ProjectView> {
	const project = await existing(id);
	const env = Object.fromEntries(
		Object.entries(change.env)
			.map(([key, value]) => [key, value ?? project.env[key]] as const)
			.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
	);
	await setProjectSettings(id, { ...change, env, baseImage: change.baseImage?.trim() || null });
	return present(await existing(id));
}
