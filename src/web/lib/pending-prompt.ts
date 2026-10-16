import type { ImageAttachment } from '@/lib/attachments';

/**
 * A prompt typed on the launcher, waiting for its new task's thread to send
 * it. Its text is kept in sessionStorage so a reload before the thread loads
 * keeps it; its images, too large for that, only in memory, for the moment
 * the launcher hands over to the thread.
 */
const key = (sessionId: string) => `anton.pending.${sessionId}`;
const pendingImages = new Map<string, ImageAttachment[]>();

export function setPendingPrompt(sessionId: string, prompt: string, images: ImageAttachment[] = []) {
	if (images.length) pendingImages.set(sessionId, images);
	try {
		sessionStorage.setItem(key(sessionId), prompt);
	} catch {}
}

export function takePendingPrompt(sessionId: string): { prompt: string; images: ImageAttachment[] } | undefined {
	const images = pendingImages.get(sessionId) ?? [];
	pendingImages.delete(sessionId);
	try {
		const prompt = sessionStorage.getItem(key(sessionId)) ?? undefined;
		sessionStorage.removeItem(key(sessionId));
		return prompt ? { prompt, images } : undefined;
	} catch {
		return undefined;
	}
}
