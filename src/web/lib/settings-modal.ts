import { useSyncExternalStore } from 'react';

/* Whether Settings is open and the address it opened at; the card keeps its own history from there. */

let href: string | null = null;
let expanded = false;
const listeners = new Set<() => void>();
const emit = () => {
	for (const listener of listeners) listener();
};

export function openSettings(at = '/settings') {
	href = at.startsWith('/settings') ? at : '/settings';
	emit();
}

export function closeSettings() {
	if (href === null) return;
	href = null;
	emit();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

export function toggleSettingsExpanded() {
	expanded = !expanded;
	emit();
}

export function useSettingsHref(): string | null {
	return useSyncExternalStore(subscribe, () => href, () => null);
}

export function useSettingsExpanded(): boolean {
	return useSyncExternalStore(subscribe, () => expanded, () => false);
}
