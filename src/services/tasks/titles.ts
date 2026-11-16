import { titleModel } from '../models/general.ts';
import { splitAttachments } from '../../core/attachments.ts';
import type { Usage } from '../../core/types.ts';
import { getSessionRecord, updateSession } from '../../db/sessions.ts';
import { getProviders } from '../../providers/index.ts';
import { logProblem } from '../../core/log.ts';
import { recordUsage } from '../models/usage.ts';

const MAX_TITLE = 60;
const MAX_READ = 4_000;

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

export async function shortTitle(text: string, signal?: AbortSignal): Promise<ShortTitle | null> {
	const writer = getProviders().text;
	const model = await titleModel();
	const message = splitAttachments(text).text.trim();
	if (!writer?.runs(model) || !message) return null;
	const answer = await writer.write({ model, prompt: prompt(message.slice(0, MAX_READ)), maxTokens: 30 }, signal);
	const title = cleanTitle(answer.text);
	return title ? { title, model, usage: { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, cost: answer.cost } } : null;
}

/** Unless it was renamed meanwhile. The model's call counts on the task's spend. */
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
