import { updateSession } from '../db/sessions.ts';
import { decide, hasDecisionModel, yesOf } from './decisions.ts';
import { logProblem } from './log.ts';

/**
 * Whether the coding agent's reply waits on the user: a question to answer, a
 * choice to make, something to provide. A task that does shows as needing
 * you, with the question, until your next message; one that is simply done
 * shows as done. The decision model judges the reply's end; without one, a
 * reply ending in a question does.
 */

type MessageEvent = {
	type: string;
	instanceId?: string;
	agentName?: string;
	taskId?: string;
	session?: string;
	message?: { role?: string; content?: unknown };
};

/** The question shown with the task is kept short. */
const MAX_QUESTION = 240;
/** How sure the decision model must be that the reply waits on the user. */
const WAITS = 0.6;

const lastReply = new Map<string, string>();

function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map((block) => (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : '')).join('');
}

/** Keeps the agent's latest words in its main conversation, from the runtime's events. Runs in the event observer. */
export function recordReplyText(event: MessageEvent): void {
	if (event.type !== 'message_end' || event.message?.role !== 'assistant' || !event.instanceId || event.taskId) return;
	if (event.session !== undefined && event.session !== 'default') return;
	if (event.agentName && !/^coder$/i.test(event.agentName)) return;
	const text = textOf(event.message.content).trim();
	if (text) lastReply.set(event.instanceId, text);
}

/** The last thing the reply asks: its last sentence ending in a question mark, else its last line. */
export function questionOf(reply: string): string {
	const lines = reply
		.split('\n')
		.map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/[*_`#]+/g, '').trim())
		.filter(Boolean);
	const sentences = lines.flatMap((line) => line.match(/[^.!?]+[.!?]*/g) ?? [line]).map((sentence) => sentence.trim());
	const asked = [...sentences].reverse().find((sentence) => sentence.endsWith('?'));
	const line = asked ?? lines[lines.length - 1] ?? '';
	return line.length > MAX_QUESTION ? `${line.slice(0, MAX_QUESTION - 1)}…` : line;
}

/** Whether the reply waits on the user, by the decision model, or by whether it ends in a question. */
async function waitsOnUser(id: string, reply: string): Promise<boolean> {
	if (!hasDecisionModel()) return /\?\s*$/.test(questionOf(reply));
	const answers = await decide(id, { reply: reply.slice(-3000) }, {
		waits: {
			type: 'yes-no',
			instructions: 'Does this reply end by asking the user a question, or by waiting for them to decide, provide or do something before the work can go on? A report of finished work, even one that offers more, is no.',
		},
	});
	const yes = yesOf(answers?.waits);
	return yes === null ? /\?\s*$/.test(questionOf(reply)) : yes >= WAITS;
}

/** At the end of a reply: notes what it asks the user, or that it asks nothing. */
export async function checkReply(id: string): Promise<void> {
	const reply = lastReply.get(id);
	lastReply.delete(id);
	try {
		const asking = reply && (await waitsOnUser(id, reply)) ? questionOf(reply) || 'Waiting on you' : null;
		await updateSession(id, { asking });
	} catch (error) {
		logProblem('warn', 'Could not check whether the reply waits on you', error, id);
	}
}
