import { useSyncExternalStore } from 'react';

/*
 * The file viewer beside the conversation: what an agent made (a screenshot,
 * a diagram, a report) opened full size from a card or a link in a reply,
 * with the chat still beside it. One for the whole app, opened from anywhere.
 */

/** A file in a task's Library. */
export type ViewerItem = { sessionId: string; path: string };

export type ViewerState = {
	items: ViewerItem[];
	index: number;
	/** Whose composer a drawing on an image goes to: a task's id, or a project's for its coordinator. Null where there is none. */
	composer: string | null;
};

let state: ViewerState | null = null;
const listeners = new Set<() => void>();

function set(next: ViewerState | null): void {
	state = next;
	for (const listener of listeners) listener();
}

export const sameItem = (a: ViewerItem, b: ViewerItem) => a.sessionId === b.sessionId && a.path === b.path;

/** Opens `item` in the viewer, with the rest of `items` a step away. */
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
