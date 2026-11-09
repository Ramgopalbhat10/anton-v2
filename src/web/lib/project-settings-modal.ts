import { useSyncExternalStore } from 'react';

/*
 * A project's settings open as a card over the page you are on, the way the
 * app's Settings do (components/project-settings.tsx). This holds which
 * project's card is open, and at which section.
 */

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

/** Which project's settings are open, and where; null when closed. */
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
