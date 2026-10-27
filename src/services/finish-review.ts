import { createHash } from 'node:crypto';
import { getProviders } from '../providers/index.ts';
import { changesView } from './files.ts';
import { logProblem } from './log.ts';
import { modelFor } from './sessions.ts';
import { recordUsage } from './usage.ts';
import { liveMachine } from './workspace.ts';

/*
 * A second look at a change before the reply that made it ends. A model that
 * has worked through a long conversation reads the request it started from
 * as one message among hundreds, and most tasks that fall short do so by a
 * case the request named and the change missed. So the task's own model reads
 * only the request and the diff, with nothing else in view, and lists what the
 * request asks that the change does not do. When it finds something, the agent
 * is sent back once to check those points; when it finds nothing, the reply
 * ends as it would have. One short call, on a context of the request and the
 * diff, never the conversation, and without reasoning, which on a long diff can
 * use up any budget before the list is written.
 */

/** A request is kept up to this long; a task's whole brief fits. */
const MAX_REQUEST = 30_000;
/** The diff the reviewer reads; past this its start is read, with a note. */
const MAX_PATCH = 60_000;
/**
 * Room for the list. The reviewer answers without reasoning: at low effort DeepSeek still spent 6,000 tokens thinking
 * on a real task and wrote nothing, while without it the same review took 33 seconds and half a cent.
 */
const MAX_TOKENS = 4_000;
/** Past this the reply ends without the review rather than keep the user waiting. */
const REVIEW_MS = 120_000;
/** The list the agent is given back, at most. */
const MAX_FINDINGS = 3_000;

/** Each task's latest request, whole: the latest input kept on the task is cut for its card. */
const requests = new Map<string, string>();
/** Tasks whose reply in hand was reviewed already, so a reply is reviewed once. */
const reviewed = new Set<string>();
/** The diff each task's last review read, so a later reply that changed nothing is not reviewed again. */
const lastPatch = new Map<string, string>();
const KEEP_TASKS = 200;

const remember = <T>(map: Map<string, T>, id: string, value: T) => {
	map.delete(id);
	map.set(id, value);
	if (map.size > KEEP_TASKS) map.delete(map.keys().next().value!);
};

/** Keeps the message the user gave the task, whole. */
export function noteRequest(id: string, text: string): void {
	const request = text.trim();
	if (request) remember(requests, id, request.slice(0, MAX_REQUEST));
}

/** A new reply may be reviewed again. */
export function startFinishReview(id: string): void {
	reviewed.delete(id);
}

/** The diff as the reviewer reads it: binary files as one line each, and cut past `MAX_PATCH`. */
export function reviewPatch(patch: string): string {
	const text = patch.replace(/GIT binary patch\n[\s\S]*?(?=\ndiff --git |$)/g, '[binary file]');
	return text.length > MAX_PATCH ? `${text.slice(0, MAX_PATCH)}\n[The diff goes on for ${(text.length - MAX_PATCH).toLocaleString('en-US')} more characters.]` : text;
}

export const reviewPrompt = (request: string, patch: string) =>
	[
		'A coding agent was given the request below and made the change below. You check the change against the request, with fresh eyes.',
		'',
		'<request>',
		request,
		'</request>',
		'',
		'<diff>',
		patch,
		'</diff>',
		'',
		'Find each thing the request asks for that the change does not do, or does differently from what the request says: a named function, option, flag, field, message, output format, default or edge case.',
		'Write each as one line starting with MISSING: and saying what the request asks and what the change does instead. Only what the request itself asks: no style, naming, refactoring or extra features, and nothing you are unsure the request asks.',
		'Do not list what the change already does. If it does everything the request asks, answer with the single word NONE.',
	].join('\n');

/** What the reviewer found, its MISSING: lines, or null when it found nothing. Anything else it wrote is left out. */
export function findingsOf(answer: string): string | null {
	const lines = answer
		.split('\n')
		.map((line) => /^\W*MISSING\W*:[\s*_]*(.+)$/i.exec(line.trim())?.[1]?.replace(/[*_]+$/, '').trim())
		.filter((line): line is string => Boolean(line))
		.map((line) => `- ${line}`);
	if (!lines.length) return null;
	const text = lines.join('\n');
	return text.length > MAX_FINDINGS ? `${text.slice(0, MAX_FINDINGS)}…` : text;
}

type Call = { tool: string };
type Deps = { patch: (id: string) => Promise<string | null> };

async function livePatch(id: string): Promise<string | null> {
	if (!(await liveMachine(id))) return null;
	return (await changesView(id)).patch;
}

/**
 * At the end of a reply that changed the code: what to tell the agent when a fresh read of the request and the diff
 * finds something the request asks that the change does not do; null otherwise. Once a reply, never on a reply that
 * ends asking the user or proposing a plan, nor on a diff already reviewed. The review counts on the task's spend.
 */
export async function finishReview(id: string, calls: readonly Call[], signal?: AbortSignal, deps: Deps = { patch: livePatch }): Promise<string | null> {
	const request = requests.get(id);
	if (!request || reviewed.has(id)) return null;
	const last = calls[calls.length - 1]?.tool;
	if (last === 'ask' || last === 'propose_plan') return null;
	const writer = getProviders().text;
	const { model } = modelFor(id);
	if (!writer?.runs(model)) return null;
	reviewed.add(id);
	try {
		const patch = await deps.patch(id);
		if (!patch?.trim()) return null;
		const digest = createHash('sha256').update(request).update(patch).digest('hex');
		if (lastPatch.get(id) === digest) return null;
		remember(lastPatch, id, digest);
		const answer = await writer.write({ model, prompt: reviewPrompt(request, reviewPatch(patch)), maxTokens: MAX_TOKENS, reasoning: 'off', timeoutMs: REVIEW_MS }, signal);
		void recordUsage(id, { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, cost: answer.cost }, model);
		const findings = findingsOf(answer.text);
		if (!findings) return null;
		return (
			'A reviewer who read only the request and your diff thinks the change misses these points:\n\n' +
			`${findings}\n\n` +
			'Check each one against the request and the code. Fix those that are real, and run the tests that cover them; skip any that are wrong. Then end your reply.'
		);
	} catch (error) {
		if (!signal?.aborted) logProblem('warn', 'The change was not reviewed', error, id);
		return null;
	}
}
