import type { Project, ProjectSettings } from '../../core/types.ts';
import { config } from '../../config.ts';
import { announce } from '../../core/changes.ts';
import { clearWarmImage, deleteProjectRecord, getProject, listProjects, projectSessionIds, setProjectSettings, upsertProject } from '../../db/projects.ts';
import { getSetting, setSetting } from '../../db/settings.ts';
import { getProviders } from '../../providers/index.ts';
import { InvalidInputError, NotFoundError } from '../../core/errors.ts';
import { renewPreparedImage } from '../sandbox/prepared-images.ts';
import { mergeEnv } from '../secrets/secrets.ts';
import { deleteSession } from '../tasks/sessions.ts';

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/** Variable names, never their values. */
export type ProjectView = Omit<Project, 'env' | 'warmImage'> & { envKeys: string[] };

function present({ env, warmImage, warmedAt, ...project }: Project): ProjectView {
	return {
		...project,
		warmedAt: warmImage ? warmedAt : null,
		envKeys: Object.keys(env).sort(),
	};
}

export async function addProject(fullName: string): Promise<ProjectView> {
	if (!REPO_NAME.test(fullName)) throw new InvalidInputError('Use the form owner/name');
	const repo = await getProviders().git.getRepo(fullName);
	const project = await upsertProject(repo.fullName, repo.defaultBranch);
	// Built now, in the background, so even the repo's first task starts from it rather than cloning.
	renewPreparedImage(project.id);
	return present(project);
}

export async function addableRepos(): Promise<string[]> {
	const [reachable, known] = await Promise.all([getProviders().git.listRepos(), listProjects()]);
	const added = new Set(known.map((project) => project.repoFullName.toLowerCase()));
	return reachable.filter((name) => !added.has(name.toLowerCase()));
}

/** Seeds ANTON_DEFAULT_REPO the first time, so removing it later keeps it removed. */
export async function projects(): Promise<ProjectView[]> {
	const known = await listProjects();
	if (known.length > 0 || !config.defaultRepo || (await getSetting('seededDefaultRepo', false))) return known.map(present);
	const seeded = await addProject(config.defaultRepo);
	await setSetting('seededDefaultRepo', true);
	return [seeded];
}

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

export const MAX_CHECK_COMMAND = 2_000;

/** A variable set to null keeps its stored value and one left out is removed. Other fields left out keep what they are. */
export type SettingsChange = Omit<ProjectSettings, 'env' | 'followUps' | 'reviewOthers' | 'fullVm' | 'checkCommand'> & {
	env: Record<string, string | null>;
	checkCommand?: string;
	followUps?: boolean;
	reviewOthers?: boolean;
	fullVm?: boolean;
};

/** Running tasks get variables from their next command and the check command from their next change; ports, base image and full VM once the sandbox restarts. */
export async function updateSettings(id: string, change: SettingsChange): Promise<ProjectView> {
	const project = await existing(id);
	const checkCommand = change.checkCommand?.trim() ?? project.checkCommand;
	if (checkCommand.length > MAX_CHECK_COMMAND) throw new InvalidInputError(`Keep the check command under ${MAX_CHECK_COMMAND.toLocaleString('en-US')} characters`);
	const env = mergeEnv(project.env, change.env);
	await setProjectSettings(id, {
		...change,
		env,
		checkCommand,
		followUps: change.followUps ?? project.followUps,
		reviewOthers: change.reviewOthers ?? project.reviewOthers,
		fullVm: change.fullVm ?? project.fullVm,
		baseImage: change.baseImage?.trim() || null,
	});
	return present(await existing(id));
}

export async function rebuildPreparedImage(id: string): Promise<ProjectView> {
	await existing(id);
	await clearWarmImage(id);
	renewPreparedImage(id);
	return present(await existing(id));
}
