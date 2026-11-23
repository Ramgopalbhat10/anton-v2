/** At the reply's end `checkReply` marks the task waiting on you with the question, without judging the reply's words. */

const asked = new Map<string, string>();

export function noteAsk(id: string, question: string): void {
	asked.set(id, question);
}

export function takeAsk(id: string): string | null {
	const question = asked.get(id) ?? null;
	asked.delete(id);
	return question;
}

/** A connector call that asked for the user's Run or Send ends the reply (`terminate`), as `ask` does; set until the next reply starts. */
const awaitingRun = new Set<string>();

export function noteAwaitingRun(id: string): void {
	awaitingRun.add(id);
}

export function startAwaitingRun(id: string): void {
	awaitingRun.delete(id);
}

/**
 * The checks at a reply's end leave alone a reply that ends waiting on the user: a question, a plan, or a call waiting on
 * Run or Send. A connector call shows only as `connector_call` among the calls, so it is told by the note above; sent back,
 * the agent would ask again and leave a second card for the same write.
 */
export function endsOnUser(id: string, calls: readonly { tool: string }[]): boolean {
	const last = calls[calls.length - 1]?.tool;
	return last === 'ask' || last === 'propose_plan' || awaitingRun.has(id);
}

/** At the reply's end `checkReply` keeps it with the task; a reply that proposes none leaves no plan waiting. */
const plans = new Map<string, string>();

export function notePlan(id: string, plan: string): void {
	plans.set(id, plan);
}

export function takePlan(id: string): string | null {
	const plan = plans.get(id) ?? null;
	plans.delete(id);
	return plan;
}
