import { createHash, randomUUID } from 'node:crypto';
import { unrouted } from '../core/model-route.ts';
import type { AgentSpan, CompactionSpan, ModelSpan, ToolSpan, Trace, TraceMessage, TracePart, TraceSpan } from '../core/trace.ts';
import { measureRequest, scaleParts } from './context-usage.ts';

/**
 * Each reply's trace, for the trace modal in the thread: every model call and
 * tool call the reply made, its subagents' too, on one clock. The runtime
 * tells Anton the request of each call (system prompt, tools, messages) and
 * what the provider counted, cache reads and writes apart, so a call's trace
 * says what went into its context, what it added since the call before, and
 * whether the cache held. Kept per reply, cut to sizes that stay readable,
 * and saved when the reply finishes (`src/db/traces.ts`).
 */

/** Spans one trace keeps; the rest are counted as dropped. */
const MAX_SPANS = 600;
/** Messages kept of what a call added, the latest; and characters kept of each. */
const MAX_ADDED = 8;
const MESSAGE_CHARS = 2500;
const INPUT_CHARS = 4000;
const OUTPUT_CHARS = 8000;
const PROMPT_CHARS = 60_000;

type LlmContent = { type: string; text?: string; thinking?: string; name?: string; id?: string; arguments?: unknown; mimeType?: string };
type LlmMessage = { role?: string; content?: string | LlmContent[]; toolName?: string };
type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };

type TraceEvent = {
	type: string;
	instanceId?: string;
	agentName?: string;
	taskId?: string;
	turnId?: string;
	timestamp?: string;
	purpose?: string;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	durationMs?: number;
	prompt?: string;
	agent?: string;
	reason?: string;
	estimatedTokens?: number;
	messagesBefore?: number;
	messagesAfter?: number;
	error?: unknown;
	request?: { providerId?: string; requestedModel?: string; input?: { systemPrompt?: string; messages?: LlmMessage[]; tools?: Array<{ name?: string }> } };
	response?: { usage?: Usage; output?: { content?: LlmContent[] }; finishReason?: string; responseModel?: string; error?: { message?: string } };
};

type Request = { parts: Record<TracePart, number>; messages: number; added: TraceMessage[]; addedMore: number; prompt: string; toolset: string };

type Open = {
	trace: Trace;
	started: number;
	requests: Map<string, Request>;
	tools: Map<string, ToolSpan>;
	agents: Map<string, AgentSpan>;
	compactions: Map<string, CompactionSpan>;
	/** How many messages each conversation's latest call sent, to tell what the next one added. */
	sent: Map<string, number>;
	/** `task` calls about to start a subagent, by brief: the runtime's start event names neither the call nor its lane. */
	delegating: Map<string, { call: string; lane: string; description: string | null }>;
};

const open = new Map<string, Open>();

/** A reply starts: trace it from now. */
export function startTrace(id: string): void {
	open.set(id, {
		trace: { id: randomUUID(), sessionId: id, startedAt: new Date().toISOString(), durationMs: 0, model: null, spans: [], prompts: {}, toolsets: {}, dropped: 0 },
		started: Date.now(),
		requests: new Map(),
		tools: new Map(),
		agents: new Map(),
		compactions: new Map(),
		sent: new Map(),
		delegating: new Map(),
	});
}

const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars)}…` : text);
const keyOf = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);
const estimate = (text: string) => Math.ceil(text.length / 4);
const json = (value: unknown) => {
	if (value === undefined) return '';
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value, null, 2) ?? '';
	} catch {
		return String(value);
	}
};

/** A message's content as text: images named, tool calls as their name and arguments. */
function contentText(content: LlmMessage['content']): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) => {
			if (part.type === 'text') return part.text ?? '';
			if (part.type === 'thinking') return part.thinking ? `[thinking] ${part.thinking}` : '';
			if (part.type === 'image') return `[image ${part.mimeType ?? ''}]`.replace(' ]', ']');
			if (part.type === 'toolCall') return `→ ${part.name}(${json(part.arguments).replace(/\s+/g, ' ')})`;
			return '';
		})
		.filter(Boolean)
		.join('\n');
}

function messageOf(message: LlmMessage): TraceMessage {
	const text = contentText(message.content);
	const role = message.role === 'assistant' || message.role === 'toolResult' || message.role === 'user' ? message.role : 'system';
	return { role, text: cut(text, MESSAGE_CHARS), chars: text.length, ...(message.toolName ? { tool: message.toolName } : {}) };
}

/** A tool's result as text: the runtime's `{ content }`, else the value as JSON. */
function resultText(result: unknown): string {
	if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) return contentText((result as LlmMessage).content);
	return json(result);
}

/**
 * The messages a call added to its conversation: those past what the previous call sent, or, for a
 * conversation's first call in the reply (or one after a compaction shrank it), those after the model's last word.
 */
function addedMessages(messages: LlmMessage[], before: number | undefined): LlmMessage[] {
	if (before !== undefined && before <= messages.length) return messages.slice(before);
	let last = messages.length - 1;
	while (last >= 0 && messages[last].role !== 'assistant') last--;
	return messages.slice(last + 1);
}

const laneOf = (event: TraceEvent) => event.taskId ?? 'main';
const errorText = (error: unknown) => (error == null ? null : typeof error === 'string' ? error : ((error as { message?: string }).message ?? 'Failed'));

function push(state: Open, span: TraceSpan): boolean {
	if (state.trace.spans.length >= MAX_SPANS) {
		state.trace.dropped++;
		return false;
	}
	state.trace.spans.push(span);
	return true;
}

/**
 * Records one runtime event into its task's open trace. The reviewer, working
 * under a task's id, has replies of its own and is left out. Runs in the event
 * observer, synchronously, so a reply's last call is in its trace by the time it finishes.
 */
export function recordTraceEvent(event: TraceEvent): void {
	if (!event.instanceId) return;
	if (event.agentName && /^reviewer$/i.test(event.agentName)) return;
	const state = open.get(event.instanceId);
	if (!state) return;
	const now = event.timestamp ? Date.parse(event.timestamp) || Date.now() : Date.now();
	const at = Math.max(0, now - state.started);
	const lane = laneOf(event);
	switch (event.type) {
		case 'turn_request': {
			const input = event.request?.input;
			if (!event.turnId || !input) return;
			const messages = input.messages ?? [];
			const prompt = input.systemPrompt ?? '';
			const promptKey = keyOf(prompt);
			state.trace.prompts[promptKey] ??= cut(prompt, PROMPT_CHARS);
			const tools = (input.tools ?? []).map((tool) => ({ name: tool.name ?? 'tool', tokens: estimate(JSON.stringify(tool)) }));
			const toolsetKey = keyOf(tools.map((tool) => `${tool.name}:${tool.tokens}`).join('\n'));
			state.trace.toolsets[toolsetKey] ??= tools;
			// Compaction's summaries read the conversation without joining it.
			const own = event.purpose === undefined || event.purpose === 'agent';
			const added = addedMessages(messages, state.sent.get(lane));
			if (own) state.sent.set(lane, messages.length);
			state.requests.set(event.turnId, {
				parts: measureRequest(input),
				messages: messages.length,
				added: added.slice(-MAX_ADDED).map(messageOf),
				addedMore: Math.max(0, added.length - MAX_ADDED),
				prompt: promptKey,
				toolset: toolsetKey,
			});
			return;
		}
		case 'turn': {
			if (!event.turnId) return;
			const request = state.requests.get(event.turnId);
			state.requests.delete(event.turnId);
			const usage = event.response?.usage;
			const traced = usage
				? { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost: usage.cost?.total ?? 0 }
				: null;
			const model = unrouted(`${event.request?.providerId ?? ''}/${event.request?.requestedModel ?? ''}`);
			if (lane === 'main' && (event.purpose === undefined || event.purpose === 'agent') && event.request?.requestedModel) state.trace.model = model;
			const total = traced ? traced.input + traced.cacheRead + traced.cacheWrite : 0;
			const estimates = request?.parts ?? { systemPrompt: 0, skills: 0, tools: 0, mcpTools: 0, messages: 0 };
			const parts = Object.fromEntries(scaleParts(estimates, total || Object.values(estimates).reduce((a, b) => a + b, 0)).map((part) => [part.key, part.tokens])) as Record<TracePart, number>;
			const content = event.response?.output?.content ?? [];
			const span: ModelSpan = {
				kind: 'model',
				id: event.turnId,
				lane,
				start: Math.max(0, at - (event.durationMs ?? 0)),
				durationMs: event.durationMs ?? 0,
				error: event.isError ? (event.response?.error?.message ?? 'The call failed') : null,
				purpose: event.purpose ?? 'agent',
				model,
				served: event.response?.responseModel || null,
				usage: traced,
				parts,
				messages: request?.messages ?? 0,
				added: request?.added ?? [],
				addedMore: request?.addedMore ?? 0,
				prompt: request?.prompt ?? '',
				toolset: request?.toolset ?? '',
				output: {
					text: cut(content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n'), OUTPUT_CHARS),
					thinking: cut(content.flatMap((part) => (part.type === 'thinking' && part.thinking ? [part.thinking] : [])).join('\n'), OUTPUT_CHARS),
					toolCalls: content.flatMap((part) => (part.type === 'toolCall' ? [{ id: part.id ?? '', name: part.name ?? 'tool' }] : [])),
				},
				finish: event.response?.finishReason ?? null,
			};
			push(state, span);
			return;
		}
		case 'tool_start': {
			if (!event.toolCallId || state.tools.has(event.toolCallId)) return;
			const span: ToolSpan = { kind: 'tool', id: event.toolCallId, lane, start: at, durationMs: 0, error: null, tool: event.toolName ?? 'tool', input: cut(json(event.args), INPUT_CHARS), output: '', outputChars: 0 };
			if (push(state, span)) state.tools.set(event.toolCallId, span);
			if (event.toolName === 'task') {
				const args = (event.args ?? {}) as { prompt?: unknown; description?: unknown };
				if (typeof args.prompt === 'string') state.delegating.set(args.prompt, { call: event.toolCallId, lane, description: typeof args.description === 'string' ? args.description : null });
			}
			return;
		}
		case 'tool': {
			const span = event.toolCallId ? state.tools.get(event.toolCallId) : undefined;
			if (!span) return;
			state.tools.delete(span.id);
			const output = resultText(event.result);
			span.durationMs = event.durationMs ?? at - span.start;
			span.output = cut(output, OUTPUT_CHARS);
			span.outputChars = output.length;
			span.error = event.isError ? cut(output, 300) || 'The tool failed' : null;
			return;
		}
		case 'task_start': {
			if (!event.taskId || state.agents.has(event.taskId)) return;
			const prompt = event.prompt ?? '';
			const delegated = state.delegating.get(prompt);
			state.delegating.delete(prompt);
			const span: AgentSpan = {
				kind: 'agent',
				id: event.taskId,
				lane: event.taskId,
				start: at,
				durationMs: 0,
				error: null,
				agent: event.agent ?? 'flue-general',
				parent: delegated?.lane ?? 'main',
				call: delegated?.call ?? null,
				description: delegated?.description ?? null,
				prompt: cut(prompt, INPUT_CHARS),
				result: '',
			};
			if (push(state, span)) state.agents.set(event.taskId, span);
			return;
		}
		case 'task': {
			const span = event.taskId ? state.agents.get(event.taskId) : undefined;
			if (!span) return;
			state.agents.delete(span.id);
			const result = resultText(event.result);
			span.durationMs = event.durationMs ?? at - span.start;
			span.result = cut(result, OUTPUT_CHARS);
			span.error = event.isError ? cut(result, 300) || 'The agent failed' : null;
			return;
		}
		case 'compaction_start': {
			const span: CompactionSpan = { kind: 'compaction', id: `compaction-${lane}-${at}`, lane, start: at, durationMs: 0, error: null, reason: event.reason ?? null, tokensBefore: event.estimatedTokens ?? null, messagesBefore: null, messagesAfter: null };
			if (push(state, span)) state.compactions.set(lane, span);
			return;
		}
		case 'compaction': {
			const span = state.compactions.get(lane);
			if (!span) return;
			state.compactions.delete(lane);
			span.durationMs = event.durationMs ?? at - span.start;
			span.messagesBefore = event.messagesBefore ?? null;
			span.messagesAfter = event.messagesAfter ?? null;
			span.error = event.isError ? (errorText(event.error) ?? 'Compaction failed') : null;
			// The conversation was rewritten: the next call's new messages are told afresh.
			state.sent.delete(lane);
			return;
		}
		default:
			return;
	}
}

/** The reply's trace, ending it; null when its start was not seen (a reply resumed after a restart) or it did nothing. */
export function finishTrace(id: string): Trace | null {
	const state = open.get(id);
	open.delete(id);
	if (!state || state.trace.spans.length === 0) return null;
	const end = Date.now() - state.started;
	// Calls the runtime never closed (a stopped reply) end with it.
	for (const span of [...state.tools.values(), ...state.agents.values(), ...state.compactions.values()]) {
		span.durationMs = Math.max(0, end - span.start);
		span.error ??= 'Unfinished: the reply ended first';
	}
	state.trace.durationMs = Math.max(end, ...state.trace.spans.map((span) => span.start + span.durationMs));
	return state.trace;
}
