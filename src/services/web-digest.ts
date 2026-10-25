import { config } from '../config.ts';
import { getProviders } from '../providers/index.ts';
import { logProblem } from './log.ts';
import { cutHeadAndTail, cutResult, keepResult, limitFor, MORE_TOOL, resultText } from './tool-results.ts';
import { recordUsage } from './usage.ts';

/*
 * A long web search or fetch, read for the agent by a fast model (the TextModel
 * port, ANTON_WEB_DIGEST_MODEL) against the call's own objective, the way
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
const DIGEST_MS = 20_000;
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

const prompt = (toolName: string, objective: string, text: string) =>
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

const note = (id: string | null, total: number) =>
	`\n\n[The result ran to ${total.toLocaleString('en-US')} characters; above is what bears on the call's objective, read out by a fast model. ` +
	(id ? `For the result itself, call ${MORE_TOOL} with id "${id}" and offset 0.]` : 'For anything it left out, call the tool again with a narrower objective.]');

/**
 * A web call's long result as the conversation takes it: a digest against its objective when a model can write one
 * in time, else the cut result (for a subagent, its start and end). The digest's call counts on the task's spend.
 */
export async function digestResult<T>(conversation: string, toolCallId: string, toolName: string, result: T, subagent = false): Promise<T> {
	const objective = objectives.get(toolCallId);
	objectives.delete(toolCallId);
	const cut = () => (subagent ? cutHeadAndTail(toolName, result) : cutResult(conversation, toolCallId, toolName, result));
	const text = resultText(result);
	const writer = getProviders().text;
	const model = config.webDigestModel;
	if (text === null || Buffer.byteLength(text) <= limitFor(toolName) || !objective || !writer?.runs(model)) return cut();
	try {
		const answer = await writer.write({ model, prompt: prompt(toolName, objective, text), maxTokens: MAX_TOKENS }, AbortSignal.timeout(DIGEST_MS));
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
