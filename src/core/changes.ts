import { EventEmitter } from 'node:events';

/** What changed, so open pages refetch only that: the task list, one task's state or files, a subscription sign-in, or the pinned models. */
export type Change = { kind: 'sessions' } | { kind: 'task'; id: string; what: 'state' | 'files' } | { kind: 'subscriptions' } | { kind: 'models' };

const bus = new EventEmitter().setMaxListeners(0);

export function announce(change: Change): void {
	bus.emit('change', change);
}

/** Calls `listener` on every change until the returned function is called. */
export function onChange(listener: (change: Change) => void): () => void {
	bus.on('change', listener);
	return () => void bus.off('change', listener);
}
