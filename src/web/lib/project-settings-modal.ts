import { useSyncExternalStore } from 'react';

/* Which project's settings card is open over the page, and at which section. */

export const PROJECT_SECTIONS = ['general', 'instructions', 'memory', 'repositories', 'usage', 'lifecycle'] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

export type ProjectSettingsAt = { spaceId: string; section: ProjectSection };

let open: ProjectSettingsAt | null = null;
const listeners = new Set<() => void>();
const emit = () => {
	for (const listener of listeners) listener();
};

export function openProjectSettings(spaceId: string, section: ProjectSection = 'general') {
	open = { spaceId, section };
	emit();
}

export function closeProjectSettings() {
	if (open === null) return;
	open = null;
	emit();
}

export function useProjectSettings(): ProjectSettingsAt | null {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		() => open,
		() => null,
	);
}
