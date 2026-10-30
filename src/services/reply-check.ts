import { updateSession } from '../db/sessions.ts';
import { isWorking } from './activity.ts';
import { takeAsk, takePlan } from './asks.ts';
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
/** The words of the agent's latest message, empty when it had none, so a reply's end is read from its last message alone. */
const lastWords = new Map<string, string>();
/** Everything the agent said in its current reply, as a reply can say its findings and then a closing line. */
const replyTexts = new Map<string, string[]>();

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
	lastWords.set(event.instanceId, text);
	if (!text) return;
	lastReply.set(event.instanceId, text);
	replyTexts.set(event.instanceId, [...(replyTexts.get(event.instanceId) ?? []), text]);
}

/** The last thing the reply asks: its last sentence ending in a question mark, else its last line. */
export function questionOf(reply: string): string {
	const lines = reply
		.split('\n')
		.map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/[*_`#]+/g, '').trim())
		.filter(Boolean);
	// A sentence ends at a stop followed by a space, so file names like docs/projects.md stay whole.
	const sentences = lines.flatMap((line) => line.split(/(?<=[.!?])\s+/)).map((sentence) => sentence.trim());
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

/** How sure the decision model must be that a thread's reply finished its work before the thread is marked done. */
const FINISHED = 0.7;

/**
 * Whether a reply delivered what was asked, with nothing left for anyone to
 * do: the file is made, the change is in, the document is written. A thread
 * whose reply does is done, as Claude closes a thread once its result is
 * delivered; an answer to a question, a report of progress or a reply that
 * offers a next step leaves it open. Only the decision model judges this, so
 * without one a thread stays open until you mark it done.
 */
export async function finishesWork(id: string, asked: string | null, reply: string): Promise<boolean> {
	const answers = await decide(id, { asked: asked?.slice(-1500) ?? '', reply: reply.slice(-3000) }, {
		finished: {
			type: 'yes-no',
			instructions:
				'Did this reply deliver the finished result of what was asked (a file made, a change made, a document or diagram written), so nothing is left for anyone to do? An answer to a question, a report of progress, a plan, a partial result, or a reply that offers or waits on a next step is no.',
		},
	});
	return (yesOf(answers?.finished) ?? 0) >= FINISHED;
}

/** How long a message must be to say something of substance, rather than narrate a step ("Let me read the entry point."). */
const SUBSTANCE = 280;

/**
 * What a reply in several messages comes to: its last message, with those
 * before it back to the last one of substance, since a reply often reports
 * and then closes with a line. Narration from earlier steps is left out, so
 * the thread's card and the coordinator read the outcome, not the opening.
 */
export function closingOf(texts: string[]): string | null {
	const kept: string[] = [];
	for (const text of [...texts].reverse()) {
		kept.unshift(text);
		if (text.length >= SUBSTANCE) break;
	}
	return kept.length ? kept.join('\n\n') : null;
}

/**
 * At the end of a reply: notes what it asks the user, or that it asks nothing, and the plan it proposed for
 * approval, or that none waits. Returns what the reply comes to (`closingOf`), when it had any text.
 */
export async function checkReply(id: string): Promise<string | null> {
	const reply = lastReply.get(id);
	const whole = closingOf(replyTexts.get(id) ?? []);
	const ask = takeAsk(id);
	const plan = takePlan(id);
	lastReply.delete(id);
	lastWords.delete(id);
	replyTexts.delete(id);
	try {
		// A question asked with the ask tool waits on the user by its nature.
		const asking = ask ? ask.slice(0, MAX_QUESTION) : reply && (await waitsOnUser(id, reply)) ? questionOf(reply) || 'Waiting on you' : null;
		// A message sent while the reply was judged has the agent working on it; its own reply says what it waits on.
		if (!isWorking(id)) await updateSession(id, { asking, plan });
	} catch (error) {
		logProblem('warn', 'Could not check whether the reply waits on you', error, id);
	}
	// The coordinator and the thread's card read the question too, when it was asked with the tool, and the plan waiting on approval.
	return [whole ?? reply, ask, plan ? `Plan waiting for approval:\n${plan}` : null].filter(Boolean).join('\n\n') || null;
}

/** Tasks whose reply in hand was already sent back to work, so a reply is sent back once. */
const nudged = new Set<string>();

/** A new reply may be sent back again. */
export function startStallCheck(id: string): void {
	nudged.delete(id);
}

/** A message that only says what the agent will do next ("I'll start by exploring the repository."). */
const ANNOUNCES = /^(?:(?:ok(?:ay)?|alright|sure|great)[,.!]?\s+)?(?:i['’]ll|i will|i['’]m going to|let me(?! know)|let['’]s|now,? i['’]ll|next,? i['’]ll|first,? i['’]ll)\b/i;

/**
 * When a reply is about to end on a message that only announces its next step, as some models do, so the
 * work it promised never runs and the task ends with nothing done: what to tell the agent so it carries on;
 * null otherwise. Once a reply, and never when the reply ends asking the user or proposing a plan.
 */
export function stallReminder(id: string, calls: readonly { tool: string }[]): string | null {
	const text = lastWords.get(id);
	if (!text || nudged.has(id)) return null;
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
	if (text.length >= SUBSTANCE || text.includes('?') || !ANNOUNCES.test(text)) return null;
	nudged.add(id);
	return 'Your reply ended on a step you said you would take, without taking it. Carry on with the work now, and end your reply once it is done or you need the user.';
}
