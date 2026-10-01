/** A prompt typed on the launcher, waiting for its new session's thread to send it. */
const pending = new Map<string, string>();

export function setPendingPrompt(sessionId: string, prompt: string) {
	pending.set(sessionId, prompt);
}

export function takePendingPrompt(sessionId: string): string | undefined {
	const prompt = pending.get(sessionId);
	pending.delete(sessionId);
	return prompt;
}
