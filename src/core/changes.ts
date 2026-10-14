import { EventEmitter } from 'node:events';

/**
 * What changed, so open pages refetch only that: the task list, one task's state, files, browser, computer, subagents, todo list or script calls,
 * a subscription sign-in, the pinned models, a project's list, threads, files or settings, or a page's state.
 */
export type Change =
	| { kind: 'sessions' }
	| { kind: 'task'; id: string; what: 'state' | 'files' | 'browser' | 'computer' | 'subagents' | 'todos' | 'scripts' }
	| { kind: 'subscriptions' }
	| { kind: 'models' }
	| { kind: 'spaces' }
	| { kind: 'space'; id: string; what: 'threads' | 'files' | 'settings' }
	/** A copy of a page saved its state; `from` is that copy, so it skips its own echo. */
	| { kind: 'page'; id: string; path: string; version: number; from: string };

const bus = new EventEmitter().setMaxListeners(0);

export function announce(change: Change): void {
	bus.emit('change', change);
}

/** Calls `listener` on every change until the returned function is called. */
export function onChange(listener: (change: Change) => void): () => void {
	bus.on('change', listener);
	return () => void bus.off('change', listener);
}
