import { getSessionJoins, setSessionJoins } from '../db/sessions.ts';
import { logProblem } from './log.ts';

/**
 * A message sent while the agent works joins the reply in hand: the agent
 * reads it at the next step and answers within that reply. The runtime lists
 * such a message after the whole reply, so a thread could only show it below
 * the answer it got. Anton notes where the agent read it, after which tool
 * call of the reply (and whether the reply had already said its last words),
 * from the runtime's events, and the thread shows the message there.
 */
export type Join = { text: string; afterTool: string; final: boolean; at: string };

/** Enough of a message to tell it from the others in its thread; the page compares the same length. */
export const JOIN_TEXT = 500;
/** A task keeps the latest; older ones are long scrolled past. */
const MAX_JOINS = 50;

type JoinEvent = {
	type: string;
	instanceId?: string;
	session?: string;
	agentName?: string;
	taskId?: string;
	toolCallId?: string;
	message?: { role?: string; content?: unknown };
};

/** Where each task's reply in hand stands: its latest tool call, and whether a step since then ended without one. */
const replies = new Map<string, { tool: string; final: boolean }>();

/** The coding agent's own conversation: not a subagent's, nor the reviewer's. */
const isMain = (event: JoinEvent) =>
	Boolean(event.instanceId) && !event.taskId && (event.session === undefined || event.session === 'default') && (!event.agentName || /^coder$/i.test(event.agentName));

const callsTools = (content: unknown) => Array.isArray(content) && content.some((block) => block && typeof block === 'object' && /tool/i.test(String((block as { type?: unknown }).type)));

/** Follows the reply in hand from the runtime's events. Runs in the event observer; never throws. */
export function recordJoinEvent(event: JoinEvent): void {
	if (event.type === 'submission_settled') {
		if (event.instanceId) replies.delete(event.instanceId);
		return;
	}
	if (!isMain(event)) return;
	const id = event.instanceId!;
	if (event.type === 'tool_start' && event.toolCallId) replies.set(id, { tool: event.toolCallId, final: false });
	else if (event.type === 'message_end' && event.message?.role === 'assistant' && !callsTools(event.message.content)) {
		const reply = replies.get(id);
		if (reply) reply.final = true;
	}
}

export async function joinsFor(id: string): Promise<Join[]> {
	const saved = await getSessionJoins(id);
	if (!saved) return [];
	try {
		const joins = JSON.parse(saved) as unknown;
		return Array.isArray(joins) ? (joins as Join[]) : [];
	} catch {
		return [];
	}
}

/**
 * For each message the agent is given: one given once the reply in hand has
 * run a tool joined that reply there, and is noted. A message that starts a
 * reply has nothing before it.
 */
export async function noteDelivery(id: string, text: string, at = new Date()): Promise<void> {
	const reply = replies.get(id);
	if (!reply) return;
	try {
		const join: Join = { text: text.trim().slice(0, JOIN_TEXT), afterTool: reply.tool, final: reply.final, at: at.toISOString() };
		await setSessionJoins(id, JSON.stringify([...(await joinsFor(id)), join].slice(-MAX_JOINS)));
	} catch (error) {
		logProblem('warn', 'Could not note where a message joined the reply', error, id);
	}
}
