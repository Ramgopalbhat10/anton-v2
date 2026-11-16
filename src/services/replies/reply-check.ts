import { updateSession } from '../../db/sessions.ts';
import { isWorking } from '../tasks/activity.ts';
import { takeAsk, takePlan } from './asks.ts';
import { decide, hasDecisionModel, yesOf } from '../models/decisions.ts';
import { changeGate, gate, loadGate, type Said } from './gate-state.ts';
import { logProblem } from '../../core/log.ts';

/** A reply that waits on you shows the task as needing you until your next message. The decision model judges; without one, a reply ending in a question does. */

type MessageEvent = {
	type: string;
	instanceId?: string;
	agentName?: string;
	taskId?: string;
	session?: string;
	message?: { role?: string; content?: unknown };
};

const MAX_QUESTION = 240;
const WAITS = 0.6;

/** Only the messages from the last of substance on are kept, with the task's checks, so a reply resumed after a restart reads the same end. */
const KEEP_SAID = 100;

const lastWordsOf = (said: Said): string => (said.silent ? '' : (said.texts[said.texts.length - 1] ?? ''));

function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map((block) => (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : '')).join('');
}

export function recordReplyText(event: MessageEvent): void {
	if (event.type !== 'message_end' || event.message?.role !== 'assistant' || !event.instanceId || event.taskId) return;
	if (event.session !== undefined && event.session !== 'default') return;
	if (event.agentName && !/^coder$/i.test(event.agentName)) return;
	const text = textOf(event.message.content).trim();
	changeGate(event.instanceId, ({ said }) => {
		said.silent = !text;
		if (!text) return;
		if (text.length >= SUBSTANCE) {
			said.start += said.texts.length;
			said.texts = [];
		}
		said.texts.push(text);
		if (said.texts.length > KEEP_SAID) {
			said.start += said.texts.length - KEEP_SAID;
			said.texts = said.texts.slice(-KEEP_SAID);
		}
	});
}

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

const FINISHED = 0.7;

/** Only the decision model judges this, so without one a thread stays open until you mark it done. */
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

const SUBSTANCE = 280;

/** Its last message, back to the last one of substance, since a reply often reports and then closes with a line. */
export function closingOf(texts: string[]): string | null {
	const kept: string[] = [];
	for (const text of [...texts].reverse()) {
		kept.unshift(text);
		if (text.length >= SUBSTANCE) break;
	}
	return kept.length ? kept.join('\n\n') : null;
}

/** Read without clearing it; empty when its last message had no words, so an earlier message is not read as its end. */
export function replyEnding(id: string, from = 0): string {
	const { said } = gate(id);
	if (!lastWordsOf(said)) return '';
	return closingOf(said.texts.slice(Math.max(0, from - said.start))) ?? '';
}

export function replyMessages(id: string): number {
	const { said } = gate(id);
	return said.start + said.texts.length;
}

export async function checkReply(id: string): Promise<string | null> {
	await loadGate(id);
	const { said } = gate(id);
	const reply = said.texts[said.texts.length - 1];
	const whole = closingOf(said.texts);
	const ask = takeAsk(id);
	const plan = takePlan(id);
	changeGate(id, (state) => {
		state.said = { start: 0, texts: [], silent: false };
	});
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

export function startStallCheck(id: string): void {
	changeGate(id, (state) => {
		state.nudged = false;
	});
}

const ANNOUNCES = /^(?:(?:ok(?:ay)?|alright|sure|great)[,.!]?\s+)?(?:i['’]ll|i will|i['’]m going to|let me(?! know)|let['’]s|now,? i['’]ll|next,? i['’]ll|first,? i['’]ll)\b/i;

/** Some models end on a message that only announces the next step, so the work never runs. Once a reply; never on `ask` or a plan. */
export function stallReminder(id: string, calls: readonly { tool: string }[]): string | null {
	const { said, nudged } = gate(id);
	const text = lastWordsOf(said);
	if (!text || nudged) return null;
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
	if (text.length >= SUBSTANCE || text.includes('?') || !ANNOUNCES.test(text)) return null;
	changeGate(id, (state) => {
		state.nudged = true;
	});
	return 'Your reply ended on a step you said you would take, without taking it. Carry on with the work now, and end your reply once it is done or you need the user.';
}
