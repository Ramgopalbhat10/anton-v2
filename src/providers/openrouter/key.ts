import { config } from '../../config.ts';

/** The key pasted in Settings › Subscriptions; the subscriptions service sets it when it loads or changes. */
let saved: string | null = null;

export function setSavedOpenRouterKey(key: string | null): void {
	saved = key;
}

/** The key OpenRouter is called with: the one pasted in Settings › Subscriptions, else OPENROUTER_API_KEY. */
export const openRouterKey = (): string | null => saved || config.openrouter.apiKey || null;

/** Where the key in use comes from. */
export const openRouterKeySource = (): 'settings' | 'environment' | null => (saved ? 'settings' : config.openrouter.apiKey ? 'environment' : null);
