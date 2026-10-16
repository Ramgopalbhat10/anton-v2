import { useSyncExternalStore } from 'react';

/**
 * The workspace panels you pinned, in the order you pinned them: a task or a
 * thread opens with these as its tabs, and with none pinned it opens on the
 * list of panels to pick from. Kept in this browser, like the panels each
 * thread had open; nothing is lost without storage, only the pins.
 */
const KEY = 'anton.pinned-panels';
const NONE: string[] = [];

let cached: { raw: string | null; names: string[] } = { raw: null, names: NONE };
const listeners = new Set<() => void>();

function read(): string[] {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(KEY);
	} catch {
		return NONE;
	}
	if (raw === cached.raw) return cached.names;
	let names = NONE;
	try {
		const parsed = JSON.parse(raw ?? 'null') as unknown;
		if (Array.isArray(parsed)) names = parsed.filter((name): name is string => typeof name === 'string');
	} catch {
		// A stored value that is not a list pins nothing.
	}
	cached = { raw, names };
	return names;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	// Pins changed in another tab show here too.
	const onStorage = (event: StorageEvent) => {
		if (event.key === KEY) listener();
	};
	window.addEventListener('storage', onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener('storage', onStorage);
	};
}

/** The pinned panels' names, as stored; the caller keeps only the names it knows. */
export const readPinnedPanels = (): string[] => read();

export function togglePinnedPanel(name: string): void {
	const current = read();
	const next = current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		return;
	}
	for (const listener of listeners) listener();
}

export function usePinnedPanels(): string[] {
	return useSyncExternalStore(subscribe, read, () => NONE);
}
