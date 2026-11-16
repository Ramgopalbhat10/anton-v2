import { useSyncExternalStore } from 'react';

/** A phone-width screen (the 700px of the workspace's container query): a panel opens only when asked, so a task opens on its conversation. */
const QUERY = '(max-width: 699px)';

const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY) : null);

function subscribe(onChange: () => void): () => void {
	const list = media();
	list?.addEventListener('change', onChange);
	return () => list?.removeEventListener('change', onChange);
}

export function useOnePane(): boolean {
	return useSyncExternalStore(subscribe, () => media()?.matches ?? false, () => false);
}
