export type KeySource = 'settings' | 'environment';

/** The key pasted in Settings, which the subscriptions service sets when it loads or changes, else the server's own. */
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
