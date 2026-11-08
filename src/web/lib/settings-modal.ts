import { useSyncExternalStore } from 'react';

/*
 * Settings opens as a card over the page you are on. This holds whether it is
 * open and the settings address it opened at (`/settings/usage`, say); the
 * card keeps its own history from there (components/settings/modal.tsx).
 */

let href: string | null = null;
const listeners = new Set<() => void>();
const emit = () => {
	for (const listener of listeners) listener();
};

/** Open Settings at a settings address, or move the open card there. */
export function openSettings(at = '/settings') {
	href = at.startsWith('/settings') ? at : '/settings';
	emit();
}

export function closeSettings() {
	if (href === null) return;
	href = null;
	emit();
}

/** Where Settings is open, or null when it is closed. */
export function useSettingsHref(): string | null {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		() => href,
		() => null,
	);
}
