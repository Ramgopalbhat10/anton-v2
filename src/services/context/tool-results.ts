import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

/*
 * A result stays in the conversation and is resent with every call until compaction, so past its limit a result keeps its
 * start and a note, and the agent reads on with `read_full_result`. A subagent has none, so its results keep start and end.
 */

/** The runtime's limit for read, kept for every other tool. */
export const MAX_RESULT_BYTES = 51_200;
/** Web search answers average 37KB of excerpts, fetches 43KB of page, and are mostly skimmed. */
const LIMITS: Record<string, number> = { mcp__web__web_search: 12_288, mcp__web__web_fetch: 24_576 };
export const limitFor = (toolName: string): number => LIMITS[toolName] ?? MAX_RESULT_BYTES;
export const MORE_TOOL = 'read_full_result';
/** Its conversation is short-lived and it reports a summary anyway. */
const SUBAGENT_LIMIT = 24_576;
/** Bash keeps the start and end of one past 16KB, with the whole in a file. */
const CUT_BY_RUNTIME = new Set(['read', 'bash', 'grep', 'glob']);
const KEEP = 20;
const KEEP_CONVERSATIONS = 50;

type Content = { type: string; text?: string };
type ToolResult = { content: Content[] };

const kept = new Map<string, Map<string, string>>();
/** By call id, the least recently cleared dropped first. */
const cleared = new Map<string, string>();
const KEEP_CLEARED = 500;

/** Cut on a character and never through a surrogate pair. */
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

export function keepResult(conversation: string, toolCallId: string, text: string): void {
	const results = kept.get(conversation) ?? new Map<string, string>();
	kept.delete(conversation);
	kept.set(conversation, results);
	if (kept.size > KEEP_CONVERSATIONS) kept.delete(kept.keys().next().value!);
	results.set(toolCallId, text);
	if (results.size > KEEP) results.delete(results.keys().next().value!);
}

/** Call ids are unique, so one map serves every conversation. */
export function keepCleared(toolCallId: string, text: string): void {
	cleared.delete(toolCallId);
	cleared.set(toolCallId, text);
	if (cleared.size > KEEP_CLEARED) cleared.delete(cleared.keys().next().value!);
}

export function resultText(result: unknown): string | null {
	if (!isResult(result)) return null;
	return result.content
		.filter((part) => part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n\n');
}

/** Its start and its end, where a command's error usually is. */
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

export function readFullResult(conversation: string, id: string, offset: number): string {
	const text = kept.get(conversation)?.get(id) ?? cleared.get(id);
	if (text === undefined) return `No result "${id}" is kept (only the latest ${KEEP} long ones are, until Anton restarts). Call the tool again, asking for less.`;
	const from = Math.max(0, Math.min(text.length, Math.floor(offset)));
	const part = partAt(text, from);
	return part + note(id, text.length, from + part.length);
}

export function forgetResults(conversation: string): void {
	kept.delete(conversation);
}

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
