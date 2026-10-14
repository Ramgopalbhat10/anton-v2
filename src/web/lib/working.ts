import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@/lib/api';

/** The task as it reads once the agent has your message: working, so no longer waiting on you. */
function working(session: Session): Session {
	// A resolved thread stays resolved (src/core/thread-state.ts); any other is working.
	const threadState = session.threadState && !session.resolvedAt ? 'working' : session.threadState;
	return { ...session, working: true, threadState };
}

/**
 * Shows the task working the moment you send it a message, so it moves to Running and its
 * "Your turn" goes without waiting for the server's next word. A list already being fetched is
 * dropped, since it was read before the message; the server counts the task working from the
 * moment the message arrives, so the next fetch agrees.
 */
export async function showWorking(queryClient: QueryClient, id: string): Promise<void> {
	await Promise.all([queryClient.cancelQueries({ queryKey: ['sessions'], exact: true }), queryClient.cancelQueries({ queryKey: ['session', id], exact: true })]);
	queryClient.setQueryData<{ sessions: Session[] }>(['sessions'], (data) =>
		data ? { ...data, sessions: data.sessions.map((session) => (session.id === id ? working(session) : session)) } : data,
	);
	queryClient.setQueryData<Session>(['session', id], (session) => (session ? working(session) : session));
}

/** After a message was turned away, reads the task again so it shows what really happened. */
export function forgetWorking(queryClient: QueryClient, id: string): void {
	void queryClient.invalidateQueries({ queryKey: ['sessions'], exact: true });
	void queryClient.invalidateQueries({ queryKey: ['session', id], exact: true });
}
