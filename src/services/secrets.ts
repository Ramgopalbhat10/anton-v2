import type { Project } from '../core/types.ts';
import { getProject, listProjects } from '../db/projects.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';

const SHARED = 'shared-env';
const GUARDRAILS = 'guardrails';

/**
 * Applies a change from the browser to stored variables: one set to null
 * keeps its stored value, one left out is removed.
 */
export function mergeEnv(stored: Record<string, string>, change: Record<string, string | null>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(change)
			.map(([key, value]) => [key, value ?? stored[key]] as const)
			.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
	);
}

/** Variables every repository's sandboxes get. */
export function sharedEnv(): Promise<Record<string, string>> {
	return getSetting<Record<string, string>>(SHARED, {});
}

/** What a repo's sandboxes get: the shared variables, with the repo's own over them. */
export async function envFor(project: Project): Promise<Record<string, string>> {
	return { ...(await sharedEnv()), ...project.env };
}

export type Guardrails = { hideSecrets: boolean };

export async function guardrails(): Promise<Guardrails> {
	return { hideSecrets: true, ...(await getSetting<Partial<Guardrails>>(GUARDRAILS, {})) };
}

export async function setGuardrails(next: Guardrails): Promise<Guardrails> {
	await setSetting(GUARDRAILS, next);
	return next;
}

/** The values to keep out of what a task's agent reads back, by name; none while the guardrail is off. */
export async function secretsToHide(sessionId: string): Promise<Record<string, string>> {
	const session = await getSessionRecord(sessionId);
	const project = session && (await getProject(session.projectId));
	return project && (await guardrails()).hideSecrets ? envFor(project) : {};
}

/** Names only, never values: the shared variables and each repository's own. */
export type SecretsView = { shared: string[]; repos: Array<{ projectId: string; repo: string; names: string[] }> };

export async function secretsView(): Promise<SecretsView> {
	const [shared, projects] = await Promise.all([sharedEnv(), listProjects()]);
	return {
		shared: Object.keys(shared).sort(),
		repos: projects
			.map((project) => ({ projectId: project.id, repo: project.repoFullName, names: Object.keys(project.env).sort() }))
			.filter((repo) => repo.names.length > 0),
	};
}

export async function setSharedEnv(change: Record<string, string | null>): Promise<SecretsView> {
	await setSetting(SHARED, mergeEnv(await sharedEnv(), change));
	return secretsView();
}
