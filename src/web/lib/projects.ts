import { useQuery } from '@tanstack/react-query';
import { api, type Project } from '@/lib/api';

const KEY = 'anton.project';

export function useProjects() {
	return useQuery({ queryKey: ['projects'], queryFn: api.projects });
}

/** Remembers the repo of the last task, so the next one starts there too. */
export function rememberProject(id: string) {
	try {
		localStorage.setItem(KEY, id);
	} catch {
		// Storage is a convenience; without it the first repo is the default.
	}
}

export function chooseProject(projects: Project[], preferred?: string): Project | undefined {
	let remembered: string | null = null;
	try {
		remembered = localStorage.getItem(KEY);
	} catch {}
	return projects.find((project) => project.id === (preferred || remembered)) ?? projects[0];
}
