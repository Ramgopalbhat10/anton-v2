import { EventEmitter } from 'node:events';
import type { AgentNow } from './agent-now.ts';

/**
 * What changed, so open pages refetch only that: the task list, one task's state, files, browser, computer, subagents, todo list or script calls,
 * a subscription sign-in, the MCP servers and connected accounts, the pinned models, a project's list, threads, files or settings, or a page's state.
 * What an agent is doing this moment comes whole, since it changes too often to be fetched each time.
 */
export type Change =
	| { kind: 'sessions' }
	| { kind: 'task'; id: string; what: 'state' | 'files' | 'browser' | 'computer' | 'subagents' | 'todos' | 'scripts' | 'joins' | 'mail' }
	| { kind: 'subscriptions' }
	| { kind: 'connectors' }
	| { kind: 'models' }
	| { kind: 'spaces' }
	| { kind: 'space'; id: string; what: 'threads' | 'files' | 'settings' }
	/** A copy of a page saved its state; `from` is that copy, so it skips its own echo. */
	| { kind: 'page'; id: string; path: string; version: number; from: string }
	| { kind: 'now'; id: string; now: AgentNow | null };

const bus = new EventEmitter().setMaxListeners(0);

export function announce(change: Change): void {
	bus.emit('change', change);
}

/** Calls `listener` on every change until the returned function is called. */
export function onChange(listener: (change: Change) => void): () => void {
	bus.on('change', listener);
	return () => void bus.off('change', listener);
}
