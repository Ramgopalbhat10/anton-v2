/**
 * A deadline for one browser or computer step. Playwright's own timeouts cover
 * loading a page and acting on it, but not reaching the browser, finding its
 * tab or what runs around the step, and one step that never returned once held
 * a thread for 22 minutes. Past the deadline, or when the reply is stopped, the
 * step answers with a problem and `giveUp` lets go of whatever it waited on.
 */
export class StepGivenUp extends Error {
	readonly reason: 'deadline' | 'stopped';
	constructor(reason: 'deadline' | 'stopped', ms: number) {
		super(reason === 'stopped' ? 'The step was stopped.' : `The step did not finish within ${Math.round(ms / 1000)} seconds and was given up.`);
		this.reason = reason;
	}
}

/** Stop awaiting work that cannot itself act on the screen; the work may still finish in the background. */
export function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	work.catch(() => undefined);
	return new Promise<T>((resolve, reject) => {
		const abort = () => { cleanup(); reject(signal.reason ?? new Error('The step was stopped.')); };
		const cleanup = () => signal.removeEventListener('abort', abort);
		if (signal.aborted) return abort();
		signal.addEventListener('abort', abort, { once: true });
		work.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
	});
}

/** The longest one browser action may take, a `do` step's actions each. */
export const STEP_MS = 60_000;
/** A computer step: finding the target, acting and describing the screen, each a vision model call. */
export const COMPUTER_STEP_MS = 120_000;

export function withinDeadline<T>(work: Promise<T>, ms: number, signal?: AbortSignal, giveUp?: () => void): Promise<T> {
	// Once given up, the step's own end is nobody's to handle.
	work.catch(() => undefined);
	return new Promise<T>((resolve, reject) => {
		const end = (reason: 'deadline' | 'stopped') => {
			cleanup();
			giveUp?.();
			reject(new StepGivenUp(reason, ms));
		};
		const timer = setTimeout(() => end('deadline'), ms);
		const onAbort = () => end('stopped');
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		};
		if (signal?.aborted) return end('stopped');
		signal?.addEventListener('abort', onAbort, { once: true });
		work.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}
