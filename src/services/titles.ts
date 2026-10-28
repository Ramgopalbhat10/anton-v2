import { titleModel } from './general.ts';
import { splitAttachments } from '../core/attachments.ts';
import type { Usage } from '../core/types.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { logProblem } from './log.ts';
import { recordUsage } from './usage.ts';

/*
 * (the TextModel port; Settings › General, else ANTON_TITLE_MODEL) from its first message, not the
 * (the TextModel port, ANTON_TITLE_MODEL) from its first message, not the
 * message itself. Until the model answers, and without an OpenRouter key, the
 * title is the start of the message, cut at a word.
 */

/** The longest title kept; the model is asked for far fewer. */
const MAX_TITLE = 60;
/** How much of the message the model reads: a title needs the gist, not the whole brief. */
const MAX_READ = 4_000;

/** The start of a message as a title, cut at a word: what a task is called until (or without) a short one. */
export function titleFrom(text: string): string {
	const line = (splitAttachments(text).text.trim().split('\n')[0] ?? '').replace(/\.+$/, '').trim();
	if (line.length <= MAX_TITLE) return line;
	const cut = line.slice(0, MAX_TITLE - 1);
	const space = cut.lastIndexOf(' ');
	return `${(space > MAX_TITLE / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const prompt = (message: string) =>
	[
		'Name this task in 2 to 6 words, as a person would title it in a list of tasks: what it is about, not the instructions.',
		'Sentence case, no quotes, no ending punctuation, no "Task:" prefix. Keep names of products, repositories and files as written.',
		'Reply with the title only.',
		'',
		'<message>',
		message,
		'</message>',
	].join('\n');

/** The model's answer as a title: its first line, without quotes, a label or an ending stop; null when nothing usable is left. */
export function cleanTitle(text: string): string | null {
	const line = (text.trim().split('\n')[0] ?? '')
		.replace(/^(?:title|task)\s*:\s*/i, '')
		.replace(/[*_`#]+/g, '')
		.replace(/^["'“‘]+|["'”’]+$/g, '')
		.replace(/[.!。]+$/, '')
		.trim();
	if (!line || line.length > MAX_TITLE * 2) return null;
	return line.length > MAX_TITLE ? titleFrom(line) : line;
}

export type ShortTitle = { title: string; usage: Usage; model: string };

/** A few words on what the message asks, from the title model; null without one, or when the message has no words. */
export async function shortTitle(text: string, signal?: AbortSignal): Promise<ShortTitle | null> {
	const writer = getProviders().text;
	const model = await titleModel();
	const message = splitAttachments(text).text.trim();
	if (!writer?.runs(model) || !message) return null;
	const answer = await writer.write({ model, prompt: prompt(message.slice(0, MAX_READ)), maxTokens: 30 }, signal);
	const title = cleanTitle(answer.text);
	return title ? { title, model, usage: { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, cost: answer.cost } } : null;
}

/**
 * Names a task from its first message, in the background: its title is replaced by a short one, unless it was
 * renamed meanwhile. The model's call counts on the task's spend.
 */
export async function nameTask(id: string, text: string): Promise<void> {
	try {
		const before = (await getSessionRecord(id))?.title;
		const named = await shortTitle(text);
		if (!named) return;
		await recordUsage(id, named.usage, named.model);
		const now = await getSessionRecord(id);
		if (!now || now.title !== before || now.title === named.title) return;
		await updateSession(id, { title: named.title });
	} catch (error) {
		logProblem('warn', 'Could not name the task', error, id);
	}
}
