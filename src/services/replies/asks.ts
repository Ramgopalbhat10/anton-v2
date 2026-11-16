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
