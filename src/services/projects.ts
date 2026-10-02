import type { Project } from '../core/types.ts';
import { config } from '../config.ts';
import { getProject, listProjects, upsertProject } from '../db/projects.ts';
import { getProviders } from '../providers/index.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/** Adds a repository by `owner/name`, checking it exists on the git host. */
export async function addProject(fullName: string): Promise<Project> {
	if (!REPO_NAME.test(fullName)) throw new InvalidInputError('Use the form owner/name');
	const repo = await getProviders().git.getRepo(fullName);
	return upsertProject(repo.fullName, repo.defaultBranch);
}

/** Known repositories; seeds ANTON_DEFAULT_REPO the first time. */
export async function projects(): Promise<Project[]> {
	const known = await listProjects();
	if (known.length > 0 || !config.defaultRepo) return known;
	return [await addProject(config.defaultRepo)];
}

export async function branches(projectId: string): Promise<string[]> {
	const project = await getProject(projectId);
	if (!project) throw new NotFoundError('Project not found');
	return getProviders().git.listBranches(project.repoFullName);
}
