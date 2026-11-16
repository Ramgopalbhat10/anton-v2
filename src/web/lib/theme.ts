import { useSyncExternalStore } from 'react';

/*
 * Light is a peer theme, not an afterthought: the same tokens resolve to
 * paper neutrals. The choice lives in localStorage; before one is made the
 * system preference decides, and dark stays the product's own default.
 */

export type Theme = 'dark' | 'light';
const KEY = 'anton.theme';

let current: Theme = 'dark';
const listeners = new Set<() => void>();

function systemTheme(): Theme {
	return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches
		? 'light'
		: 'dark';
}

function stored(): Theme | null {
	try {
		const value = localStorage.getItem(KEY);
		return value === 'light' || value === 'dark' ? value : null;
	} catch {
		return null;
	}
}

/** The theme in effect, resolved once at startup by `bootTheme` (index.html runs it before paint). */
export function theme(): Theme {
	return current;
}

export function applyTheme(next: Theme) {
	current = next;
	document.documentElement.dataset.theme = next;
	const meta = document.querySelector('meta[name="theme-color"]');
	meta?.setAttribute('content', next === 'light' ? '#f4f4f5' : '#0a0a0b');
	for (const listener of listeners) listener();
}

/** Before first paint: the stored choice, else the system's, else dark. */
export function bootTheme() {
	applyTheme(stored() ?? systemTheme());
}

/** Flip to the other theme and remember it. */
export function toggleTheme() {
	const next = current === 'dark' ? 'light' : 'dark';
	try {
		localStorage.setItem(KEY, next);
	} catch {
		// Storage is a convenience; the theme still applies without it.
	}
	applyTheme(next);
}

export function useTheme(): Theme {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current,
		() => 'dark',
	);
}
