import { useSyncExternalStore } from 'react';

/** The workspace panels you pinned, in pin order: a task opens with these as its tabs. Kept in this browser. */
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
