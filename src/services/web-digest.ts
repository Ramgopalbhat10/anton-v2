import { config } from '../config.ts';
import { getProviders } from '../providers/index.ts';
import type { ModelInfo } from '../core/ports.ts';
import { backgroundModel } from './general.ts';
import { logProblem } from './log.ts';
import { loadedModels } from './models.ts';
import { modelFor } from './sessions.ts';
import { cutHeadAndTail, cutResult, keepResult, limitFor, MORE_TOOL, resultText } from './tool-results.ts';
import { recordUsage } from './usage.ts';

/*
 * A long web search or fetch, read for the agent by a fast model (the TextModel
 * port, Settings › General's background models, else ANTON_WEB_DIGEST_MODEL) against the call's own objective, the way
 * Claude Code's fetch answers a prompt rather than handing back the page. The
 * agent's conversation takes the digest, a few KB, in place of 40KB of
 * excerpts it would send again with every call after; the whole result is kept
 * for `read_full_result`. A subagent, which has no `read_full_result`, takes
 * the digest alone. Without a text model, with `off`, without an objective, or
 * when the model fails or is slow, the result is cut as any other.
 */

export const WEB_TOOLS = new Set(['mcp__web__web_search', 'mcp__web__web_fetch']);
/** How much of the result the model reads: past this, the rest is still kept whole. */
const MAX_READ = 120_000;
/** About 6KB of digest: enough for the facts, quotes and code a call was after. */
const MAX_TOKENS = 1_500;
/** Past this the agent is better off with the cut result than waiting. */
const DIGEST_MS = 8_000;
/** About what a digest comes to, against the cut result it replaces. */
const DIGEST_CHARS = 2_500;
/** The later calls a result is assumed to ride along with, read from the prompt cache, after the one that first sends it. */
const LATER_CALLS = 5;

/** Calls whose objective is waiting for their result; a call that never ends is dropped with the oldest. */
const KEEP_CALLS = 200;

type Event = { type: string; toolName?: string; toolCallId?: string; args?: unknown };

/** What each running web call is for, by call id: the runtime's interceptor sees the call's id but not its arguments. */
const objectives = new Map<string, string>();

/** The objective and queries a web call gives, as one brief; null when it gives neither. */
export function objectiveOf(args: unknown): string | null {
	const { objective, search_queries: queries } = (args ?? {}) as { objective?: unknown; search_queries?: unknown };
	const lines: string[] = [];
	if (typeof objective === 'string' && objective.trim()) lines.push(`Objective: ${objective.trim()}`);
	const asked = Array.isArray(queries) ? queries.filter((query): query is string => typeof query === 'string' && Boolean(query.trim())) : [];
	if (asked.length) lines.push(`Queries: ${asked.join('; ')}`);
	return lines.length ? lines.join('\n') : null;
}

/** Notes what a web call is for as it starts. Runs in the event observer; never throws. */
export function recordWebCall(event: Event): void {
	if (event.type !== 'tool_start' || !event.toolCallId || !WEB_TOOLS.has(event.toolName ?? '')) return;
	const objective = objectiveOf(event.args);
	if (!objective) return;
	objectives.set(event.toolCallId, objective);
	if (objectives.size > KEEP_CALLS) objectives.delete(objectives.keys().next().value!);
}

export const digestPrompt = (toolName: string, objective: string, text: string) =>
	[
		`An agent made a web ${toolName.endsWith('search') ? 'search' : 'fetch'} and you read its result for it. What the agent asked:`,
		'',
		objective,
		'',
		'Write out what in the result bears on that: facts, figures, versions, code, commands and short quotes, exactly as the result gives them, each with the URL it comes from.',
		'Leave out what does not bear on it. Do not add anything the result does not say. If nothing in it answers, say so in one line and list the URLs and titles it has.',
		'No preamble: start with the first finding.',
		'',
		'<result>',
		text.slice(0, MAX_READ),
		'</result>',
	].join('\n');

/**
 * Whether reading a result out costs less than the task's model sending its cut form: what the digest model charges to
 * read it and write about 1K tokens, against the tokens it saves at the task model's price, first written to the prompt
 * cache and then read from it. On a model as cheap as the digest model, or one with no price (a plan), it never pays,
 * and the cut result costs no extra seconds either.
 */
export function digestPays(task: Pick<ModelInfo, 'price'> | undefined, digest: Pick<ModelInfo, 'price'> | undefined, readChars: number, savedChars: number): boolean {
	if (!task || !digest || savedChars <= 0) return false;
	const dollars = (perMillion: number, chars: number) => ((perMillion || 0) * chars) / 4 / 1e6;
	const saved = dollars(task.price.cacheWrite || task.price.input, savedChars) + LATER_CALLS * dollars(task.price.cacheRead || task.price.input, savedChars);
	const spent = dollars(digest.price.input, Math.min(readChars, MAX_READ)) + dollars(digest.price.output, 4_000);
	return saved > spent;
}

const note = (id: string | null, total: number) =>
	`\n\n[The result ran to ${total.toLocaleString('en-US')} characters; above is what bears on the call's objective, read out by a fast model. ` +
	(id ? `For the result itself, call ${MORE_TOOL} with id "${id}" and offset 0.]` : 'For anything it left out, call the tool again with a narrower objective.]');

/**
 * A web call's long result as the conversation takes it: a digest against its objective when a model can write one
 * in time and it costs less than the tokens it saves (`digestPays`), else the cut result (for a subagent, its start and end). The digest's call counts on the task's spend.
 */
export async function digestResult<T>(
	conversation: string,
	toolCallId: string,
	toolName: string,
	result: T,
	subagent = false,
	models: readonly ModelInfo[] = loadedModels(),
): Promise<T> {
	const objective = objectives.get(toolCallId);
	objectives.delete(toolCallId);
	const cut = () => (subagent ? cutHeadAndTail(toolName, result) : cutResult(conversation, toolCallId, toolName, result));
	const text = resultText(result);
	const writer = getProviders().text;
	const model = backgroundModel('webDigest')!;
	if (text === null || Buffer.byteLength(text) <= limitFor(toolName) || !objective || !writer?.runs(model)) return cut();
	const task = models.find((info) => info.id === modelFor(conversation).model);
	if (!digestPays(task, models.find((info) => info.id === model), text.length, Math.min(text.length, limitFor(toolName)) - DIGEST_CHARS)) return cut();
	try {
		const answer = await writer.write({ model, prompt: digestPrompt(toolName, objective, text), maxTokens: MAX_TOKENS }, AbortSignal.timeout(DIGEST_MS));
		void recordUsage(conversation, { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, cost: answer.cost }, model);
		const digest = answer.text.trim();
		if (!digest) return cut();
		if (!subagent) keepResult(conversation, toolCallId, text);
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const others = content.filter((part) => part.type !== 'text');
		return { ...result, content: [{ type: 'text', text: digest + note(subagent ? null : toolCallId, text.length) }, ...others] };
	} catch (error) {
		logProblem('warn', 'Web result not digested; cut instead', error, conversation);
		return cut();
	}
}
