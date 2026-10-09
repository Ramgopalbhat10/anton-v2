import { createContext, useSyncExternalStore } from 'react';
import type { PanelName } from '@/components/vm-panel';

/** Shows one of the task's workspace panels, opening the workspace if it is closed. */
export const ShowPanel = createContext<(name: PanelName) => void>(() => undefined);

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
