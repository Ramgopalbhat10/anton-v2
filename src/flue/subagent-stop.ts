import { type FlueExecutionContext, type FlueExecutionOperation, instrument } from '@flue/runtime';
import { onSubagentStop } from '../services/subagent-runs.ts';

/**
 * Lets the user stop one subagent while the rest of the reply goes on. The
 * runtime runs each subagent inside the agent's `task` call and keeps no handle
 * to it outside, but it passes that run through its execution interceptors, so
 * this one races it against a stop. On a stop the call answers at once with
 * what the run had done; the runtime then closes the subagent (aborting its
 * model call and abandoning its tool) and the agent reads the answer at its
 * next step, along with any message that waited for it.
 */
export function subagentStopInterceptor<T>(operation: FlueExecutionOperation, _ctx: FlueExecutionContext, next: () => Promise<T>): Promise<T> {
	if (operation.type !== 'task') return next();
	let stop: (note: string) => void = () => undefined;
	const stopped = new Promise<string>((resolve) => {
		stop = resolve;
	});
	const forget = onSubagentStop(operation.taskId, stop);
	const work = next();
	// Once stopped, the subagent's own end (an abort) is nobody's to handle.
	work.catch(() => undefined);
	// The runtime reads the answer's text as the call's result, as it would a finished run's.
	return Promise.race([work, stopped.then((text) => ({ text }) as T)]).finally(forget);
}

const key = Symbol.for('anton.subagent-stop');
const state = globalThis as typeof globalThis & { [key]?: () => Promise<void> };

/** Installs the interceptor once, across dev-server module reloads; Flue itself survives those reloads. */
export function installSubagentStop(): void {
	void state[key]?.();
	state[key] = instrument({ observe: () => undefined, interceptor: subagentStopInterceptor, dispose: () => undefined });
}
