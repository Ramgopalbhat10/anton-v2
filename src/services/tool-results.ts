import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

/**
 * Long tool results, cut before they join an agent's conversation. Every model
 * call sends the whole conversation again, tool results included, and a result
 * stays in it until the conversation is compacted: one 300KB web page read early
 * in a thread is sent with every call after it. The runtime's own read and bash
 * stop at 50KB; a web fetch, a connector, a script or a subagent's answer had no
 * limit. So a result past 50KB keeps its first 50KB and a note, and the agent
 * reads on with `read_full_result` when it needs more. Only the agents' own
 * conversations are cut: a subagent's is short-lived, and its answer is cut
 * where it reaches the agent.
 */

/** The runtime's limit for read and bash, kept for every other tool. */
export const MAX_RESULT_BYTES = 51_200;
export const MORE_TOOL = 'read_full_result';
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

const note = (id: string, total: number, end: number) =>
	end < total
		? `\n\n[Result cut at 50KB: characters up to ${end.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} shown. Call ${MORE_TOOL} with id "${id}" and offset ${end} for more, or ask the tool for less.]`
		: '';

const isResult = (value: unknown): value is ToolResult => Boolean(value) && Array.isArray((value as ToolResult).content);

/**
 * The result as the agent's conversation takes it: whole up to 50KB of text, else its first 50KB and a
 * note, with the whole kept under the call's id for `read_full_result`. Images pass as they are.
 */
export function cutResult<T>(conversation: string, toolCallId: string, toolName: string, result: T): T {
	if (!isResult(result) || CUT_BY_RUNTIME.has(toolName) || toolName === MORE_TOOL) return result;
	const texts = result.content.filter((part) => part.type === 'text' && typeof part.text === 'string');
	const text = texts.map((part) => part.text).join('\n\n');
	if (Buffer.byteLength(text) <= MAX_RESULT_BYTES) return result;
	const results = kept.get(conversation) ?? new Map<string, string>();
	// The conversation moves to the back, so the ones dropped are those cut from longest ago.
	kept.delete(conversation);
	kept.set(conversation, results);
	if (kept.size > KEEP_CONVERSATIONS) kept.delete(kept.keys().next().value!);
	results.set(toolCallId, text);
	if (results.size > KEEP) results.delete(results.keys().next().value!);
	const head = partAt(text, 0);
	const others = result.content.filter((part) => !texts.includes(part));
	return { ...result, content: [{ type: 'text', text: head + note(toolCallId, text.length, head.length) }, ...others] };
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
		description: 'Reads more of a tool result that was cut at 50KB, from the id and offset its note gives. Read on only as far as the work needs.',
		input: v.object({
			id: v.pipe(v.string(), v.minLength(1), v.description('The id the note gives.')),
			offset: v.pipe(v.number(), v.integer(), v.minValue(0), v.description('The character to start from.')),
		}),
		run: async ({ data }) => ({ output: readFullResult(conversation, data.id, data.offset) }),
	});
}
