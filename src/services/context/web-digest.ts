import { unrouted } from '../../core/model-route.ts';
import { config } from '../../config.ts';
import { getProviders } from '../../providers/index.ts';
import type { ModelInfo } from '../../core/ports.ts';
import { backgroundModel, backgroundReasoning, textEffort } from '../models/general.ts';
import { logProblem } from '../../core/log.ts';
import { loadedModels } from '../models/models.ts';
import { modelFor } from '../tasks/sessions.ts';
import { cutHeadAndTail, cutResult, keepResult, limitFor, MORE_TOOL, resultText } from './tool-results.ts';
import { recordUsage } from '../models/usage.ts';

/*
 * A long web search or fetch is read by a fast model against the call's objective, as Claude Code's fetch does; the
 * conversation takes the few-KB digest instead of 40KB it would resend with every call. Otherwise it is cut as any result.
 */

export const WEB_TOOLS = new Set(['mcp__web__web_search', 'mcp__web__web_fetch']);
/** Past this, the rest is still kept whole. */
const MAX_READ = 120_000;
/** About 6KB of digest: enough for the facts, quotes and code a call was after. */
const MAX_TOKENS = 1_500;
/** Past this the agent is better off with the cut result than waiting. */
const DIGEST_MS = 8_000;
const DIGEST_CHARS = 2_500;
/** After the one that first sends it, read from the prompt cache. */
const LATER_CALLS = 5;

const KEEP_CALLS = 200;

type Event = { type: string; toolName?: string; toolCallId?: string; args?: unknown };

/** The runtime's interceptor sees the call's id but not its arguments. */
const objectives = new Map<string, string>();

export function objectiveOf(args: unknown): string | null {
	const { objective, search_queries: queries } = (args ?? {}) as { objective?: unknown; search_queries?: unknown };
	const lines: string[] = [];
	if (typeof objective === 'string' && objective.trim()) lines.push(`Objective: ${objective.trim()}`);
	const asked = Array.isArray(queries) ? queries.filter((query): query is string => typeof query === 'string' && Boolean(query.trim())) : [];
	if (asked.length) lines.push(`Queries: ${asked.join('; ')}`);
	return lines.length ? lines.join('\n') : null;
}

/** Runs in the event observer; never throws. */
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

/** A cache write never counts for less than input (Gemini lists its cache's storage there). On a plan, with no price, it never pays. */
export function digestPays(task: Pick<ModelInfo, 'price'> | undefined, digest: Pick<ModelInfo, 'price'> | undefined, readChars: number, savedChars: number): boolean {
	if (!task || !digest || savedChars <= 0) return false;
	const dollars = (perMillion: number, chars: number) => ((perMillion || 0) * chars) / 4 / 1e6;
	const saved = dollars(Math.max(task.price.cacheWrite, task.price.input), savedChars) + LATER_CALLS * dollars(task.price.cacheRead || task.price.input, savedChars);
	const spent = dollars(digest.price.input, Math.min(readChars, MAX_READ)) + dollars(digest.price.output, 4_000);
	return saved > spent;
}

const note = (id: string | null, total: number) =>
	`\n\n[The result ran to ${total.toLocaleString('en-US')} characters; above is what bears on the call's objective, read out by a fast model. ` +
	(id ? `For the result itself, call ${MORE_TOOL} with id "${id}" and offset 0.]` : 'For anything it left out, call the tool again with a narrower objective.]');

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
	if (!digestPays(task, models.find((info) => info.id === unrouted(model)), text.length, Math.min(text.length, limitFor(toolName)) - DIGEST_CHARS)) return cut();
	try {
		const effort = textEffort(backgroundReasoning('webDigest'));
		const answer = await writer.write(
			{ model, prompt: digestPrompt(toolName, objective, text), maxTokens: MAX_TOKENS, ...(effort ? { reasoning: effort } : {}) },
			AbortSignal.timeout(DIGEST_MS),
		);
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
