import { logProblem } from './log.ts';

/**
 * Cloudflare, in front of Anton, closes a request it has waited on for 100
 * seconds and answers with its own error page instead. A request that can
 * take longer answers by then with what it knows, and lets the work finish.
 */
export const ANSWER_MS = 80_000;

const LATER = Symbol('later');

/**
 * The work's result if it ends within `ms`; otherwise what `later` gives, while the work
 * carries on and a failure from then on is logged, since nobody waits for it any more.
 */
export async function answerWithin<T, L>(work: Promise<T>, later: () => L | Promise<L>, what: string, sessionId: string | null = null, ms = ANSWER_MS): Promise<T | L> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof LATER>((resolve) => {
		timer = setTimeout(() => resolve(LATER), ms);
	});
	try {
		const result = await Promise.race([work, deadline]);
		if (result !== LATER) return result as T;
	} finally {
		clearTimeout(timer);
	}
	work.catch((error: unknown) => logProblem('error', `${what} failed`, error, sessionId));
	return later();
}
