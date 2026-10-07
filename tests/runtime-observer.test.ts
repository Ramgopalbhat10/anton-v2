import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlueEventSubscriber } from '@flue/runtime';
import { observeRuntime } from '../src/services/runtime-observer.ts';

test('reloading the app replaces its observer and stale cleanup cannot remove the new listener', async () => {
	const listeners = new Set<FlueEventSubscriber>();
	const subscribe = (listener: FlueEventSubscriber) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	let oldDeliveries = 0,
		newDeliveries = 0;
	const old = observeRuntime(() => {
		oldDeliveries++;
	}, subscribe);
	const modulePath = '../src/services/runtime-observer.ts?reload';
	const fresh = await import(modulePath);
	const current = fresh.observeRuntime(() => {
		newDeliveries++;
	}, subscribe);
	const emit = () => {
		for (const listener of listeners)
			listener(
				{ type: 'agent_start', v: 3, eventIndex: 0, timestamp: '2026-10-07T02:31:40.179Z' },
				{ id: 'test', agentName: 'Coder', env: {}, req: undefined, log: { info() {}, warn() {}, error() {} } },
			);
	};
	emit();
	assert.equal(oldDeliveries, 0);
	assert.equal(newDeliveries, 1);
	old();
	emit();
	assert.equal(newDeliveries, 2);
	current();
	emit();
	assert.equal(newDeliveries, 2);
});
