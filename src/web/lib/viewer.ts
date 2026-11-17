import { useSyncExternalStore } from 'react';

/** A file in a task's Library, or (`src`) a picture sent with a message, which lives at its own URL and in no Library: its `path` is just its name. */
export type ViewerItem = { sessionId: string; path: string; src?: string };

export type ViewerState = {
	items: ViewerItem[];
	index: number;
	/** Whose composer a drawing on an image goes to: a task's id, or a project's for its coordinator. Null where there is none. */
	composer: string | null;
};

let state: ViewerState | null = null;
const listeners = new Set<() => void>();
let dock: HTMLElement | null = null;
const dockListeners = new Set<() => void>();

export function setViewerDock(next: HTMLElement | null): void {
	dock = next;
	for (const listener of dockListeners) listener();
}

export function useViewerDock(): HTMLElement | null {
	return useSyncExternalStore(
		(listener) => {
			dockListeners.add(listener);
			return () => void dockListeners.delete(listener);
		},
		() => dock,
		() => null,
	);
}

function set(next: ViewerState | null): void {
	state = next;
	for (const listener of listeners) listener();
}

export const sameItem = (a: ViewerItem, b: ViewerItem) => a.sessionId === b.sessionId && a.path === b.path && a.src === b.src;

export function openViewer(item: ViewerItem, items: ViewerItem[], composer: string | null): void {
	const list = items.some((other) => sameItem(other, item)) ? items : [item];
	set({ items: list, index: list.findIndex((other) => sameItem(other, item)), composer });
}

export function closeViewer(): void {
	set(null);
}

export function stepViewer(by: number): void {
	if (!state || state.items.length < 2) return;
	set({ ...state, index: (state.index + by + state.items.length) % state.items.length });
}

export function useViewer(): ViewerState | null {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		() => state,
		() => null,
	);
}
