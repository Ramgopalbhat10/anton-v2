/**
 * A prompt typed on the launcher, waiting for its new task's thread to send
 * it. Kept in sessionStorage so a reload before the thread loads keeps it.
 */
const key = (sessionId: string) => `anton.pending.${sessionId}`;

export function setPendingPrompt(sessionId: string, prompt: string) {
	try {
		sessionStorage.setItem(key(sessionId), prompt);
	} catch {}
}

export function takePendingPrompt(sessionId: string): string | undefined {
	try {
		const prompt = sessionStorage.getItem(key(sessionId)) ?? undefined;
		sessionStorage.removeItem(key(sessionId));
		return prompt;
	} catch {
		return undefined;
	}
}
