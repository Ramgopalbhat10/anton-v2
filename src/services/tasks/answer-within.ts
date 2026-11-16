import { logProblem } from '../../core/log.ts';

/** Cloudflare, in front of Anton, closes a request after 100 s with its own error page; a long request answers by then and lets the work finish. */
export const ANSWER_MS = 80_000;

const LATER = Symbol('later');

/** Past `ms`, answers with `later` while the work carries on; a failure from then on is only logged. */
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
