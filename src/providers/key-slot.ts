/** Where a gateway's key comes from: pasted in Settings › Subscriptions, or the server's own. */
export type KeySource = 'settings' | 'environment';

/**
 * A gateway's key as its calls use it: the one pasted in Settings ›
 * Subscriptions, which the subscriptions service sets when it loads or
 * changes, else the server's own from the environment.
 */
export type KeySlot = {
	set(key: string | null): void;
	get(): string | null;
	source(): KeySource | null;
};

export function keySlot(fromEnvironment: () => string): KeySlot {
	let saved: string | null = null;
	return {
		set: (key) => {
			saved = key;
		},
		get: () => saved || fromEnvironment() || null,
		source: () => (saved ? 'settings' : fromEnvironment() ? 'environment' : null),
	};
}
