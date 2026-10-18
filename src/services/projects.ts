import type { Project, ProjectSettings } from '../core/types.ts';
import { config } from '../config.ts';
import { announce } from '../core/changes.ts';
import { clearWarmImage, deleteProjectRecord, getProject, listProjects, projectSessionIds, setProjectSettings, upsertProject } from '../db/projects.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { mergeEnv } from './secrets.ts';
import { deleteSession } from './sessions.ts';

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/**
 * What the browser sees of a repo: variable names, never their values; when
 * its prepared image was built, not the image.
 */
export type ProjectView = Omit<Project, 'env' | 'warmImage'> & { envKeys: string[] };

function present({ env, warmImage, warmedAt, ...project }: Project): ProjectView {
	return {
		...project,
		warmedAt: warmImage ? warmedAt : null,
		envKeys: Object.keys(env).sort(),
	};
}

/** Adds a repository by `owner/name`, checking it exists on the git host. */
export async function addProject(fullName: string): Promise<ProjectView> {
	if (!REPO_NAME.test(fullName)) throw new InvalidInputError('Use the form owner/name');
	const repo = await getProviders().git.getRepo(fullName);
	return present(await upsertProject(repo.fullName, repo.defaultBranch));
}

/** Repos Anton's account can reach that are not added yet, most recently pushed first. */
export async function addableRepos(): Promise<string[]> {
	const [reachable, known] = await Promise.all([getProviders().git.listRepos(), listProjects()]);
	const added = new Set(known.map((project) => project.repoFullName.toLowerCase()));
	return reachable.filter((name) => !added.has(name.toLowerCase()));
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
 * value and one left out is removed. Leaving out `followUps`, `reviewOthers` or `fullVm` keeps them as they are.
 */
export type SettingsChange = Omit<ProjectSettings, 'env' | 'followUps' | 'reviewOthers' | 'fullVm'> & {
	env: Record<string, string | null>;
	followUps?: boolean;
	reviewOthers?: boolean;
	fullVm?: boolean;
};

/**
 * Saves the repo's settings. New tasks use them. Running tasks get variable
 * changes from their next command batch; preview ports, the base image and
 * the full VM apply once their sandbox restarts.
 */
export async function updateSettings(id: string, change: SettingsChange): Promise<ProjectView> {
	const project = await existing(id);
	const env = mergeEnv(project.env, change.env);
	await setProjectSettings(id, {
		...change,
		env,
		followUps: change.followUps ?? project.followUps,
		reviewOthers: change.reviewOthers ?? project.reviewOthers,
		fullVm: change.fullVm ?? project.fullVm,
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
