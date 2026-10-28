import type { UseFlueAgentResult } from '@flue/react';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
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

/**
 * Reads the task again, everywhere it shows: after a message was turned away, to show what really happened,
 * and once the server has it, as `showWorking` dropped any read under way and with it whatever changed
 * meanwhile (a new title, a question answered), which no later change would bring back.
 */
export function readTaskAgain(queryClient: QueryClient, id: string): void {
	void queryClient.invalidateQueries({ queryKey: ['sessions'], exact: true });
	void queryClient.invalidateQueries({ queryKey: ['session', id], exact: true });
}

type AgentStatus = 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error';

/**
 * The agent's status as a task's page shows it. The client counts the agent busy only for a
 * message this page sent, or while text streams; a reply started elsewhere (a project's
 * coordinator, an automation, another tab) or before the page opened would read as idle between
 * its steps, so the server's word that the task is working counts too.
 */
export function taskStatus<T extends AgentStatus>(local: T, working: boolean): T | 'streaming' {
	return working && (local === 'idle' || local === 'connecting') ? 'streaming' : local;
}

/**
 * A conversation read before its first message made it reads as absent, and
 * Flue does not follow it until it is read again: a thread whose brief the
 * server hands over once its agent is set up, or a routine's run, opened as it
 * starts showed none of its reply until you sent it something. The server
 * announces the task's state as the runtime starts and settles each reply
 * (`recordAgentEvent` in activity.ts), which reads the task again; each such
 * read (`changedAt`) reads an absent conversation again too.
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
