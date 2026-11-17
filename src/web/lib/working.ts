import type { UseFlueAgentResult } from '@flue/react';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { Session } from '@/lib/api/sessions';

function working(session: Session): Session {
	// A resolved thread stays resolved (src/core/thread-state.ts); any other is working.
	const threadState = session.threadState && !session.resolvedAt ? 'working' : session.threadState;
	return { ...session, working: true, threadState };
}

/** Shows the task working the moment you send it a message. A list being fetched is dropped, as it was read before the message; the server counts the task working from arrival, so the next fetch agrees. */
export async function showWorking(queryClient: QueryClient, id: string): Promise<void> {
	await Promise.all([queryClient.cancelQueries({ queryKey: ['sessions'], exact: true }), queryClient.cancelQueries({ queryKey: ['session', id], exact: true })]);
	queryClient.setQueryData<{ sessions: Session[] }>(['sessions'], (data) =>
		data ? { ...data, sessions: data.sessions.map((session) => (session.id === id ? working(session) : session)) } : data,
	);
	queryClient.setQueryData<Session>(['session', id], (session) => (session ? working(session) : session));
}

/** Reads the task again everywhere: after a message was turned away, and once the server has it, since `showWorking` dropped any read under way and whatever it carried. */
export function readTaskAgain(queryClient: QueryClient, id: string): void {
	void queryClient.invalidateQueries({ queryKey: ['sessions'], exact: true });
	void queryClient.invalidateQueries({ queryKey: ['session', id], exact: true });
}

type AgentStatus = 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error';

/** The client counts the agent busy only for its own message or streaming text; a reply started elsewhere would read idle between steps, so the server's `working` counts too. */
export function taskStatus<T extends AgentStatus>(local: T, working: boolean): T | 'streaming' {
	return working && (local === 'idle' || local === 'connecting') ? 'streaming' : local;
}

/**
 * Flue does not follow a conversation read before its first message (absent) until it is read again, so a thread whose brief
 * arrives once its agent is set up showed none of its reply. Each read of the task (`changedAt`) reads an absent one again.
 */
export function useFollowOnceStarted(agent: Pick<UseFlueAgentResult, 'historyReady' | 'messages' | 'refresh'>, changedAt: number) {
	const absent = agent.historyReady && agent.messages.length === 0;
	const refresh = agent.refresh;
	// The read of the task it was found absent at, so it is read again only once the task is read again.
	const seenAt = useRef<number | null>(null);
	useEffect(() => {
		if (!absent) {
			seenAt.current = null;
			return;
		}
		if (seenAt.current === null) seenAt.current = changedAt;
		else if (seenAt.current !== changedAt) {
			seenAt.current = changedAt;
			refresh();
		}
	}, [absent, changedAt, refresh]);
}
