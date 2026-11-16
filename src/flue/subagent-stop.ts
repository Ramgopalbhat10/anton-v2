import { type FlueExecutionContext, type FlueExecutionOperation, instrument } from '@flue/runtime';
import { endOverTime, onSubagentStop } from '../services/tasks/subagent-runs.ts';

/** So a stuck subagent cannot hold the reply for good. ANTON_SUBAGENT_MINUTES changes it. */
export const SUBAGENT_BUDGET_MS = (Number(process.env.ANTON_SUBAGENT_MINUTES) || 20) * 60_000;

/**
 * The runtime keeps no handle to a subagent outside the agent's `task` call, but passes that run through its execution
 * interceptors, so this races it against a stop. On a stop the call answers at once with what the run had done.
 */
export function subagentStopInterceptor<T>(operation: FlueExecutionOperation, ctx: FlueExecutionContext, next: () => Promise<T>, budgetMs = SUBAGENT_BUDGET_MS): Promise<T> {
	if (operation.type !== 'task') return next();
	let stop: (note: string) => void = () => undefined;
	const stopped = new Promise<string>((resolve) => {
		stop = resolve;
	});
	const forget = onSubagentStop(operation.taskId, stop);
	// Past its budget the run ends as a stop does, with a note saying why.
	const overTime = ctx.instanceId ? setTimeout(() => void endOverTime(ctx.instanceId!, operation.taskId, budgetMs).catch(() => undefined), budgetMs) : null;
	overTime?.unref?.();
	const work = next();
	// Once stopped, the subagent's own end (an abort) is nobody's to handle.
	work.catch(() => undefined);
	// The runtime reads the answer's text as the call's result, as it would a finished run's.
	return Promise.race([work, stopped.then((text) => ({ text }) as T)]).finally(() => {
		if (overTime) clearTimeout(overTime);
		forget();
	});
}

const key = Symbol.for('anton.subagent-stop');
const state = globalThis as typeof globalThis & { [key]?: () => Promise<void> };

/** Installs the interceptor once, across dev-server module reloads; Flue itself survives those reloads. */
export function installSubagentStop(): void {
	void state[key]?.();
	state[key] = instrument({ observe: () => undefined, interceptor: (operation, ctx, next) => subagentStopInterceptor(operation, ctx, next), dispose: () => undefined });
}
