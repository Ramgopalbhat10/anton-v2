/**
 * Questions the agent asked with its `ask` tool in the reply under way, per
 * task. The thread shows each with its options to tap; at the reply's end
 * `checkReply` marks the task waiting on you with the question, without
 * judging the reply's words.
 */

const asked = new Map<string, string>();

export function noteAsk(id: string, question: string): void {
	asked.set(id, question);
}

/** The question the reply asked, if it asked one, and forgets it. */
export function takeAsk(id: string): string | null {
	const question = asked.get(id) ?? null;
	asked.delete(id);
	return question;
}

/**
 * The plan the reply proposed with `propose_plan` in plan mode, per task. At
 * the reply's end `checkReply` keeps it with the task, so the task waits on
 * your approval; a reply that proposes none leaves no plan waiting.
 */
const plans = new Map<string, string>();

export function notePlan(id: string, plan: string): void {
	plans.set(id, plan);
}

/** The plan the reply proposed, if it proposed one, and forgets it. */
export function takePlan(id: string): string | null {
	const plan = plans.get(id) ?? null;
	plans.delete(id);
	return plan;
}
