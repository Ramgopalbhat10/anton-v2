import type { ThinkingLevel } from '@flue/runtime';

export const DEFAULT_MODEL = 'openrouter/anthropic/claude-sonnet-4';

/**
 * `thinking` is the reasoning level each model runs at. Anthropic models run
 * without it through OpenRouter, which drops their thinking blocks between
 * turns; Anthropic then rejects the next tool call.
 */
export const MODELS = [
	{ id: 'openrouter/anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', thinking: 'off' },
	{ id: 'openrouter/anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', thinking: 'off' },
	{ id: 'openrouter/moonshotai/kimi-k2.6', label: 'Kimi K2.6', thinking: 'medium' },
] as const satisfies ReadonlyArray<{ id: string; label: string; thinking: ThinkingLevel }>;

export function isKnownModel(id: string): boolean {
	return MODELS.some((model) => model.id === id);
}

export function thinkingFor(id: string): ThinkingLevel {
	return MODELS.find((model) => model.id === id)?.thinking ?? 'medium';
}
