/*
 * The reviewer subagent runs at most once a reply. Offered freely, a model called it four times in one reply (Nov 2026):
 * each review found something new in the last round's fix, the agent built more to answer it, and the reply ran 40
 * minutes and 18M tokens past a change finished in 16. The Coder stops offering it once it has run (`useTaskSubagents`);
 * the runtime then answers a call for it with the subagents still on offer.
 */

const ran = new Set<string>();

export const reviewerRan = (id: string): boolean => ran.has(id);

export function noteReviewerRun(id: string): void {
	ran.add(id);
}

/** At each reply's start, with the other checks. */
export function startReviewerRuns(id: string): void {
	ran.delete(id);
}
