import { createContext, useSyncExternalStore } from 'react';
import type { PanelName } from '@/components/vm-panel';

/** Shows one of the task's workspace panels, opening the workspace if it is closed. */
export const ShowPanel = createContext<(name: PanelName) => void>(() => undefined);

/** A place in the task's files a reply points at: a repository file in Files, or a changed file in Changes. */
export type FileFocus = { path: string; line?: number; at: number };

const fileFocus = new Map<string, FileFocus>();
const changeFocus = new Map<string, FileFocus>();
const focusListeners = new Set<() => void>();

function subscribeFocus(listener: () => void) {
	focusListeners.add(listener);
	return () => void focusListeners.delete(listener);
}

/** Opens a file in the Files panel at a line; `at` makes asking again for the same place open it again. */
export function focusFile(sessionId: string, path: string, line?: number): void {
	fileFocus.set(sessionId, { path, line, at: Date.now() });
	for (const listener of focusListeners) listener();
}

/** Picks a changed file in the Changes panel. */
export function focusChange(sessionId: string, path: string): void {
	changeFocus.set(sessionId, { path, at: Date.now() });
	for (const listener of focusListeners) listener();
}

export function useFocusedFile(sessionId: string): FileFocus | null {
	return useSyncExternalStore(subscribeFocus, () => fileFocus.get(sessionId) ?? null);
}

export function useFocusedChange(sessionId: string | undefined): FileFocus | null {
	return useSyncExternalStore(subscribeFocus, () => (sessionId ? (changeFocus.get(sessionId) ?? null) : null));
}

/** The subagent run the Agents panel shows, per task; null shows the list. */
const focused = new Map<string, string | null>();
const listeners = new Set<() => void>();

export function focusRun(sessionId: string, runId: string | null): void {
	focused.set(sessionId, runId);
	for (const listener of listeners) listener();
}

export function useFocusedRun(sessionId: string): string | null {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		() => focused.get(sessionId) ?? null,
	);
}
