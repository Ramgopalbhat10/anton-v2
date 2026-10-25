import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

/**
 * Long tool results, cut before they join an agent's conversation. Every model
 * call sends the whole conversation again, tool results included, and a result
 * stays in it until the conversation is compacted: one 300KB web page read early
 * in a thread is sent with every call after it. The runtime's own read and bash
 * stop at 50KB; a web fetch, a connector, a script or a subagent's answer had no
 * limit. So a result past 50KB keeps its first 50KB and a note, and the agent
 * reads on with `read_full_result` when it needs more. A subagent has no
 * `read_full_result`, so its long results keep their start and end, and its
 * answer is cut again where it reaches the agent.
 */

/** The runtime's limit for read and bash, kept for every other tool. */
export const MAX_RESULT_BYTES = 51_200;
/**
 * Lower limits for tools whose results run long and are mostly skimmed: a web search answers with
 * several pages' excerpts (37KB on average), a fetch with whole pages (43KB). The agent reads on
 * with `read_full_result` when the start was not enough.
 */
const LIMITS: Record<string, number> = { mcp__web__web_search: 12_288, mcp__web__web_fetch: 24_576 };
export const limitFor = (toolName: string): number => LIMITS[toolName] ?? MAX_RESULT_BYTES;
export const MORE_TOOL = 'read_full_result';
/** A subagent's results, cut harder: its conversation is short-lived and it reports a summary anyway. */
const SUBAGENT_LIMIT = 24_576;
/** The runtime's tools that cut their own output, with notes of their own on reading the rest. */
const CUT_BY_RUNTIME = new Set(['read', 'bash', 'grep', 'glob']);
/** The long results each conversation keeps for `read_full_result`, the oldest dropped first. */
const KEEP = 20;
/** Conversations whose long results are kept, those cut from longest ago dropped first. */
const KEEP_CONVERSATIONS = 50;

type Content = { type: string; text?: string };
type ToolResult = { content: Content[] };

const kept = new Map<string, Map<string, string>>();

/** The text from `offset` that fits in `bytes`, cut on a character and never through a surrogate pair. */
export function partAt(text: string, offset: number, bytes = MAX_RESULT_BYTES): string {
	let part = text.slice(offset, offset + bytes);
	for (let excess = Buffer.byteLength(part) - bytes; excess > 0; excess = Buffer.byteLength(part) - bytes) part = part.slice(0, part.length - Math.max(1, Math.floor(excess / 4)));
	if (/[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1);
	return part;
}

const note = (id: string, total: number, end: number, bytes = MAX_RESULT_BYTES) =>
	end < total
		? `\n\n[Result cut at ${Math.round(bytes / 1024)}KB: characters up to ${end.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} shown. Call ${MORE_TOOL} with id "${id}" and offset ${end} for more, or ask the tool for less.]`
		: '';

const isResult = (value: unknown): value is ToolResult => Boolean(value) && Array.isArray((value as ToolResult).content);

/** Keeps a result whole under its call's id, for `read_full_result`. */
export function keepResult(conversation: string, toolCallId: string, text: string): void {
	const results = kept.get(conversation) ?? new Map<string, string>();
	// The conversation moves to the back, so the ones dropped are those cut from longest ago.
	kept.delete(conversation);
	kept.set(conversation, results);
	if (kept.size > KEEP_CONVERSATIONS) kept.delete(kept.keys().next().value!);
	results.set(toolCallId, text);
	if (results.size > KEEP) results.delete(results.keys().next().value!);
}

/** The text parts of a tool result, joined; null for anything that is not one. */
export function resultText(result: unknown): string | null {
	if (!isResult(result)) return null;
	return result.content
		.filter((part) => part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n\n');
}

/** A subagent's long result, which it cannot read on from: its start and its end, where a command's error usually is. */
export function cutHeadAndTail<T>(toolName: string, result: T): T {
	if (!isResult(result) || CUT_BY_RUNTIME.has(toolName)) return result;
	const texts = result.content.filter((part) => part.type === 'text' && typeof part.text === 'string');
	const text = texts.map((part) => part.text).join('\n\n');
	const limit = Math.min(limitFor(toolName), SUBAGENT_LIMIT);
	if (Buffer.byteLength(text) <= limit) return result;
	const head = partAt(text, 0, Math.floor((limit * 2) / 3));
	const tailBytes = limit - Buffer.byteLength(head);
	let from = Math.max(head.length, text.length - tailBytes);
	while (Buffer.byteLength(text.slice(from)) > tailBytes) from += Math.max(1, Math.floor((Buffer.byteLength(text.slice(from)) - tailBytes) / 4));
	if (/[\uDC00-\uDFFF]/.test(text[from] ?? '')) from += 1;
	const middle = `\n\n[${(from - head.length).toLocaleString('en-US')} characters of ${text.length.toLocaleString('en-US')} left out here. Ask the tool for less to see them.]\n\n`;
	const others = result.content.filter((part) => !texts.includes(part));
	return { ...result, content: [{ type: 'text', text: head + middle + text.slice(from) }, ...others] };
}

/**
 * The result as the agent's conversation takes it: whole up to its tool's limit (50KB, less for web search and fetch), else its start and a
 * note, with the whole kept under the call's id for `read_full_result`. Images pass as they are.
 */
export function cutResult<T>(conversation: string, toolCallId: string, toolName: string, result: T): T {
	if (!isResult(result) || CUT_BY_RUNTIME.has(toolName) || toolName === MORE_TOOL) return result;
	const texts = result.content.filter((part) => part.type === 'text' && typeof part.text === 'string');
	const text = texts.map((part) => part.text).join('\n\n');
	const limit = limitFor(toolName);
	if (Buffer.byteLength(text) <= limit) return result;
	keepResult(conversation, toolCallId, text);
	const head = partAt(text, 0, limit);
	const others = result.content.filter((part) => !texts.includes(part));
	return { ...result, content: [{ type: 'text', text: head + note(toolCallId, text.length, head.length, limit) }, ...others] };
}

/** More of a cut result, from `offset`, up to 50KB at a time. */
export function readFullResult(conversation: string, id: string, offset: number): string {
	const text = kept.get(conversation)?.get(id);
	if (text === undefined) return `No result "${id}" is kept (only the latest ${KEEP} long ones are, until Anton restarts). Call the tool again, asking for less.`;
	const from = Math.max(0, Math.min(text.length, Math.floor(offset)));
	const part = partAt(text, from);
	return part + note(id, text.length, from + part.length);
}

/** Forgets a conversation's long results, as when its task is deleted. */
export function forgetResults(conversation: string): void {
	kept.delete(conversation);
}

/** The tool that reads on in a cut result, for an agent whose conversation is `conversation` (its instance id). */
export function fullResultTool(conversation: string) {
	return defineTool({
		name: MORE_TOOL,
		description: 'Reads more of a tool result that was cut, from the id and offset its note gives. Read on only as far as the work needs.',
		input: v.object({
			id: v.pipe(v.string(), v.minLength(1), v.description('The id the note gives.')),
			offset: v.pipe(v.number(), v.integer(), v.minValue(0), v.description('The character to start from.')),
		}),
		run: async ({ data }) => ({ output: readFullResult(conversation, data.id, data.offset) }),
	});
}
