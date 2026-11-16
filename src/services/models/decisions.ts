import type { Answer, Decision, Question } from '../../core/ports.ts';
import { getProviders } from '../../providers/index.ts';
import { logProblem } from '../../core/log.ts';
import { recordUsage } from './usage.ts';

/** Without one, every decision falls back to what Anton did before. */
export const hasDecisionModel = () => Boolean(getProviders().decisions);

export async function consult(id: string, state: Record<string, unknown>, questions: Record<string, Question>, signal?: AbortSignal): Promise<Decision> {
	const model = getProviders().decisions;
	if (!model) throw new Error('No decision model is set up. It needs an OpenRouter key.');
	const decision = await model.decide(state, questions, signal);
	await recordUsage(id, { inputTokens: decision.inputTokens, outputTokens: 0, cost: decision.cost }, model.name);
	return decision;
}

/** Counts its cost on the task like any model call. Throws when it cannot answer. */
export async function ask(id: string, state: Record<string, unknown>, questions: Record<string, Question>, signal?: AbortSignal): Promise<Record<string, Answer>> {
	return (await consult(id, state, questions, signal)).answers;
}

export type Tally = { decisions: number; cost: number; actions: Array<{ what: string; p: number | null; failed?: boolean }> };

export const newTally = (): Tally => ({ decisions: 0, cost: 0, actions: [] });

/** Null when there is no decision model or it fails, so the caller does what it did without one. */
export async function decide(id: string, state: Record<string, unknown>, questions: Record<string, Question>, tally?: Tally): Promise<Record<string, Answer> | null> {
	if (!hasDecisionModel()) return null;
	try {
		const decision = await consult(id, state, questions);
		if (tally) {
			tally.decisions += 1;
			tally.cost += decision.cost;
		}
		return decision.answers;
	} catch (error) {
		logProblem('warn', 'The decision model could not answer', error, id);
		return null;
	}
}

export const yesOf = (answer: Answer | undefined): number | null => (answer && 'yes' in answer ? answer.yes : null);

export const choiceOf = (answer: Answer | undefined): { choice: string; p: number } | null =>
	answer && 'choice' in answer ? { choice: answer.choice, p: answer.probabilities[answer.choice] ?? 0 } : null;
