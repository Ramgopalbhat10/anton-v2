import type { Answer, Decision, Question } from '../core/ports.ts';
import { getProviders } from '../providers/index.ts';
import { logProblem } from './log.ts';
import { recordUsage } from './usage.ts';

/** Whether a decision model is set up; without one, every decision falls back to what Anton did before. */
export const hasDecisionModel = () => Boolean(getProviders().decisions);

/** `ask`, with what the answers cost. */
export async function consult(id: string, state: Record<string, unknown>, questions: Record<string, Question>, signal?: AbortSignal): Promise<Decision> {
	const model = getProviders().decisions;
	if (!model) throw new Error('No decision model is set up. It needs an OpenRouter key.');
	const decision = await model.decide(state, questions, signal);
	await recordUsage(id, { inputTokens: decision.inputTokens, outputTokens: 0, cost: decision.cost }, model.name);
	return decision;
}

/** Asks the decision model about one task, counting its cost on that task like any model call. Throws when it cannot answer. */
export async function ask(id: string, state: Record<string, unknown>, questions: Record<string, Question>, signal?: AbortSignal): Promise<Record<string, Answer>> {
	return (await consult(id, state, questions, signal)).answers;
}

/** `ask`, or null when there is no decision model or it fails, so the caller does what it did without one. */
export async function decide(id: string, state: Record<string, unknown>, questions: Record<string, Question>): Promise<Record<string, Answer> | null> {
	if (!hasDecisionModel()) return null;
	try {
		return await ask(id, state, questions);
	} catch (error) {
		logProblem('warn', 'The decision model could not answer', error, id);
		return null;
	}
}

/** The probability of yes, or null for no answer. */
export const yesOf = (answer: Answer | undefined): number | null => (answer && 'yes' in answer ? answer.yes : null);

/** The option picked and its probability, or null for no answer. */
export const choiceOf = (answer: Answer | undefined): { choice: string; p: number } | null =>
	answer && 'choice' in answer ? { choice: answer.choice, p: answer.probabilities[answer.choice] ?? 0 } : null;
