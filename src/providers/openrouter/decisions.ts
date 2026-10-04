import type { Answer, DecisionModel, Question } from '../../core/ports.ts';

export type DecisionOptions = { apiUrl: string; apiKey: string; model: string };

/** A decision is meant to be quick; one that hangs must not hold up the work waiting on it. */
const TIMEOUT_MS = 15_000;

type WireQuestion = { type: 'noul'; instructions: string } | { type: 'choice'; instructions: string; criteria: Record<string, string> };
type WireAnswer = { type?: string; noul?: number; choice?: string; probabilities?: Record<string, number> };
type WireResponse = { answers?: Record<string, WireAnswer>; usage?: { input_tokens?: number; cost?: number } };

/** TypeSafe's System One protocol calls a yes-or-no question a `noul`. */
function wireQuestion(question: Question): WireQuestion {
	return question.type === 'yes-no' ? { type: 'noul', instructions: question.instructions } : { type: 'choice', instructions: question.instructions, criteria: question.options };
}

function answerOf(id: string, question: Question, answer: WireAnswer | undefined): Answer {
	if (question.type === 'yes-no' && typeof answer?.noul === 'number') return { yes: answer.noul };
	if (question.type === 'choice' && typeof answer?.choice === 'string') return { choice: answer.choice, probabilities: answer.probabilities ?? {} };
	throw new Error(`The decision model gave no answer for ${id}`);
}

/** A System One decision model (TypeSafe's Jev by default) through OpenRouter, with the key Anton already has. */
export function openRouterDecisions({ apiUrl, apiKey, model }: DecisionOptions): DecisionModel {
	return {
		name: `openrouter/${model}`,
		async decide(state, questions, signal) {
			const timeout = AbortSignal.timeout(TIMEOUT_MS);
			const response = await fetch(`${apiUrl}/systemone`, {
				method: 'POST',
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, state, questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, wireQuestion(question)])) }),
			});
			if (!response.ok) throw new Error(`OpenRouter /systemone: ${response.status} ${(await response.text()).slice(0, 300)}`);
			const body = (await response.json()) as WireResponse;
			return {
				answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answerOf(id, question, body.answers?.[id])])),
				inputTokens: body.usage?.input_tokens ?? 0,
				cost: body.usage?.cost ?? 0,
			};
		},
	};
}
