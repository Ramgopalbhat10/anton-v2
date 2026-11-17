import type { UseFlueAgentResult } from '@flue/react';
import { useDeferredValue, useMemo } from 'react';

export function useReplyActivity(agent: UseFlueAgentResult) {
	const busy = agent.status === 'submitted' || agent.status === 'streaming';
	// Defer the finish with the words, so the mark cannot stop while React is still drawing the final chunk.
	const snapshot = useMemo(() => ({ messages: agent.messages, status: agent.status, settlements: agent.settlements, busy }), [agent.messages, agent.status, agent.settlements, busy]);
	const rendered = useDeferredValue(snapshot);
	const working = busy || rendered.busy;
	const message = rendered.messages.findLast((message) => message.role === 'assistant' && message.display === 'visible' && !message.settlement);
	const settled = message?.submissionId && rendered.settlements.some((settlement) => settlement.submissionId === message.submissionId);
	const nextUser = message && rendered.messages.slice(rendered.messages.indexOf(message) + 1).some((next) =>
		next.role === 'user' && !(message.submissionId && next.submissionId && rendered.settlements.some((settlement) => settlement.submissionId === next.submissionId && settlement.answeredBySubmissionId === message.submissionId)),
	);
	// A new send must not wake the previous reply; a message joining unfinished work must not stop it.
	const awaitingReply = (rendered.status === 'submitted' && (message?.metadata?.usage || settled || nextUser)) || (nextUser && (settled || (!message?.submissionId && message?.metadata?.usage)));
	const reply = working && rendered.busy && !awaitingReply ? message : undefined;
	return { conversation: rendered.messages, working, reply };
}
