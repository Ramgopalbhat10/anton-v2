import { config } from '../../config.ts';
import { keySlot } from '../key-slot.ts';

/** The key pasted in Settings › Subscriptions, else OPENROUTER_API_KEY. */
export const openRouterKeySlot = keySlot(() => config.openrouter.apiKey);

export function setSavedOpenRouterKey(key: string | null): void {
	openRouterKeySlot.set(key);
}

/** The key OpenRouter is called with: the one pasted in Settings › Subscriptions, else OPENROUTER_API_KEY. */
export const openRouterKey = (): string | null => openRouterKeySlot.get();

/** Where the key in use comes from. */
export const openRouterKeySource = (): 'settings' | 'environment' | null => openRouterKeySlot.source();
