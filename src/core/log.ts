/** In memory only: the host's console has the full history. */
export type LogEntry = { at: string; level: 'warn' | 'error'; message: string; detail: string | null; sessionId: string | null };

const KEEP = 300;
const entries: LogEntry[] = [];

const describe = (error: unknown) => (error === undefined ? null : error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error));

export function logProblem(level: LogEntry['level'], message: string, error?: unknown, sessionId: string | null = null): void {
	const detail = describe(error);
	(level === 'error' ? console.error : console.warn)(`[anton] ${message}`, ...(error === undefined ? [] : [error]));
	entries.push({ at: new Date().toISOString(), level, message, detail, sessionId });
	if (entries.length > KEEP) entries.splice(0, entries.length - KEEP);
}

/** Newest first. */
export function recentProblems(): LogEntry[] {
	return [...entries].reverse();
}

type RuntimeEvent = { type: string; instanceId?: string; level?: string; message?: string; outcome?: string; error?: { message?: string }; attributes?: { error?: { message?: string } } };

export function logRuntimeEvent(event: RuntimeEvent): void {
	if (event.type === 'log' && (event.level === 'warn' || event.level === 'error')) {
		logProblem(event.level, event.message ?? 'Agent runtime warning', event.attributes?.error?.message, event.instanceId ?? null);
	} else if (event.type === 'submission_settled' && event.outcome === 'failed') {
		logProblem('error', 'An agent reply failed', event.error?.message, event.instanceId ?? null);
	}
}
