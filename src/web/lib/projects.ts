import { useQuery } from '@tanstack/react-query';
import { api, type Project } from '@/lib/api';

const KEY = 'anton.project';

export function useProjects() {
	return useQuery({ queryKey: ['projects'], queryFn: api.projects });
}

/** Picked in place of a repo for a chat, which has none; remembered like a repo. */
export const NO_REPO = 'none';

/** Remembers the repo of the last task, or that it was a chat, so the next one starts the same way. */
export function rememberProject(id: string) {
	try {
		localStorage.setItem(KEY, id);
	} catch {
		// Storage is a convenience; without it the first repo is the default.
	}
}

/** The repo a new task starts on: the one picked, else the last one used, else the first; none when a chat was picked or there are no repos. */
export function chooseProject(projects: Project[], preferred?: string): Project | undefined {
	let remembered: string | null = null;
	try {
		remembered = localStorage.getItem(KEY);
	} catch {}
	const choice = preferred || remembered;
	if (choice === NO_REPO) return undefined;
	return projects.find((project) => project.id === choice) ?? projects[0];
}
