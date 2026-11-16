import { getSessionJoins, setSessionJoins } from '../../db/sessions.ts';
import { logProblem } from '../../core/log.ts';

/**
 * The runtime lists a message sent mid-reply after the whole reply; Anton notes from its events after which tool call
 * the agent read it (and whether the reply had already said its last words), so the thread shows it there.
 */
export type Join = { text: string; afterTool: string; final: boolean; at: string };

/** The page compares the same length. */
export const JOIN_TEXT = 500;
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

const replies = new Map<string, { tool: string; final: boolean }>();

const isMain = (event: JoinEvent) =>
	Boolean(event.instanceId) && !event.taskId && (event.session === undefined || event.session === 'default') && (!event.agentName || /^coder$/i.test(event.agentName));

const callsTools = (content: unknown) => Array.isArray(content) && content.some((block) => block && typeof block === 'object' && /tool/i.test(String((block as { type?: unknown }).type)));

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

/** The next write waits for this one, so two messages never read and write the list at once. */
const writing = new Map<string, Promise<void>>();

export function noteDelivery(id: string, text: string, at = new Date()): Promise<void> {
	const reply = replies.get(id);
	if (!reply) return Promise.resolve();
	const join: Join = { text: text.trim().slice(0, JOIN_TEXT), afterTool: reply.tool, final: reply.final, at: at.toISOString() };
	const next = (writing.get(id) ?? Promise.resolve()).then(async () => {
		try {
			await setSessionJoins(id, JSON.stringify([...(await joinsFor(id)), join].slice(-MAX_JOINS)));
		} catch (error) {
			logProblem('warn', 'Could not note where a message joined the reply', error, id);
		}
	});
	writing.set(id, next);
	void next.then(() => {
		if (writing.get(id) === next) writing.delete(id);
	});
	return next;
}
