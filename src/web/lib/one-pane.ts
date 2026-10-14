import { useSyncExternalStore } from 'react';

/**
 * A phone-width screen: the sidebar is a drawer, and the conversation and a
 * side panel cannot sit side by side (the same 700px the workspace's
 * container query uses). There a panel opens only when you ask for it, so a
 * task, a thread or a project opens on its conversation.
 */
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
