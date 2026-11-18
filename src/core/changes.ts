import { EventEmitter } from 'node:events';
import type { AgentNow } from './agent-now.ts';

/** What changed, so open pages refetch only that. What an agent is doing this moment comes whole, as it changes too often to fetch. */
export type Change =
	| { kind: 'sessions' }
	| { kind: 'task'; id: string; what: 'state' | 'usage' | 'files' | 'browser' | 'computer' | 'subagents' | 'todos' | 'scripts' | 'joins' | 'mail' | 'approvals' | 'pr-metadata' | 'settled' }
	| { kind: 'subscriptions' }
	| { kind: 'setup' }
	| { kind: 'connectors' }
	| { kind: 'models' }
	| { kind: 'spaces' }
	| { kind: 'space'; id: string; what: 'threads' | 'files' | 'settings' }
	| { kind: 'automations' }
	| { kind: 'notifications' }
	/** `from` is the copy that saved, so it skips its own echo. */
	| { kind: 'page'; id: string; path: string; version: number; from: string }
	| { kind: 'now'; id: string; now: AgentNow | null };

const bus = new EventEmitter().setMaxListeners(0);

export function announce(change: Change): void {
	bus.emit('change', change);
}

export function onChange(listener: (change: Change) => void): () => void {
	bus.on('change', listener);
	return () => void bus.off('change', listener);
}
