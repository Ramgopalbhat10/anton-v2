import { updateSession } from '../db/sessions.ts';
import { logProblem } from './log.ts';

/** The fields Anton reads from a runtime `message_end` event. */
type MessageEvent = {
	type: string;
	instanceId?: string;
	agentName?: string;
	taskId?: string;
	session?: string;
	message?: { role?: string; content?: unknown; timestamp?: number };
};

/** Long inputs are kept to what a card can show. */
const MAX_LENGTH = 2000;

function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n');
}

/**
 * Keeps each task's latest input, from the runtime's event for every message
 * the coding agent is given: one you typed, a follow-up, or an automation's
 * prompt. Subagents' and the reviewer's messages are not the task's input.
 */
export async function recordLatestInput(event: MessageEvent): Promise<void> {
	if (event.type !== 'message_end' || event.message?.role !== 'user' || !event.instanceId || event.taskId) return;
	// A subagent's task runs in a session of its own; only the main conversation's input is the task's.
	if (event.session !== undefined && event.session !== 'default') return;
	if (event.agentName && !/^coder$/i.test(event.agentName)) return;
	const text = textOf(event.message.content).trim();
	if (!text) return;
	const at = new Date(event.message.timestamp ?? Date.now()).toISOString();
	await updateSession(event.instanceId, { lastInput: text.slice(0, MAX_LENGTH), lastInputAt: at }).catch((error: unknown) =>
		logProblem('warn', 'Could not keep the latest input', error, event.instanceId),
	);
}
