export const DEFAULT_MODEL = 'openrouter/anthropic/claude-sonnet-4';

export const MODELS = [
	{ id: 'openrouter/anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
	{ id: 'openrouter/anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
	{ id: 'openrouter/moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
] as const;

export function isKnownModel(id: string): boolean {
	return MODELS.some((model) => model.id === id);
}
