import type { UseFlueAgentResult } from '@flue/react';
import { useDeferredValue, useMemo } from 'react';

export function useReplyActivity(agent: UseFlueAgentResult) {
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	// Defer the finish with the words, so the mark cannot stop while React is still drawing the final chunk.
	const snapshot = useMemo(() => ({ messages: agent.messages, status: agent.status, settlements: agent.settlements, busy }), [agent.messages, agent.status, agent.settlements, busy]);
	const rendered = useDeferredValue(snapshot);
	const working = busy || rendered.busy;
	const message = rendered.messages.findLast((message) => message.role === 'assistant' && message.display === 'visible' && !message.settlement);
	const settled = message?.metadata?.usage || (message?.submissionId && rendered.settlements.some((settlement) => settlement.submissionId === message.submissionId));
	const nextUser = message && rendered.messages.slice(rendered.messages.indexOf(message) + 1).some((message) => message.role === 'user');
	// A new send must not wake the previous reply; a message joining unfinished work must not stop it.
	const reply = working && rendered.busy && message && !(settled && (nextUser || rendered.status === 'submitted')) && !(nextUser && rendered.status === 'submitted') ? message : undefined;
	return { conversation: rendered.messages, working, reply };
}
