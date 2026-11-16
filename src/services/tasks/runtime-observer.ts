import { observe, type FlueEventSubscriber } from '@flue/runtime';

const key = Symbol.for('anton.runtime-observer');
const state = globalThis as typeof globalThis & { [key]?: () => void };

/** One listener across dev-server module reloads; Flue itself survives those reloads. */
export function observeRuntime(subscriber: FlueEventSubscriber, subscribe = observe): () => void {
	state[key]?.();
	const unsubscribe = subscribe(subscriber);
	state[key] = unsubscribe;
	return () => {
		unsubscribe();
		if (state[key] === unsubscribe) delete state[key];
	};
}
