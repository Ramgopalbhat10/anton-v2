/*
 * A reply's trace: every model call and tool call it made, its subagents'
 * too, on one clock. Recorded on the server from the runtime's events
 * (`src/services/response-trace.ts`) and drawn by the trace modal in the
 * thread (`src/web/components/trace-modal.tsx`), so both read these types.
 */

/** The parts of a model call's request, as the context meter splits them. */
export type TracePart = 'systemPrompt' | 'skills' | 'tools' | 'mcpTools' | 'messages';
export const TRACE_PARTS: TracePart[] = ['systemPrompt', 'skills', 'tools', 'mcpTools', 'messages'];

/** What a provider counted for one call: fresh input, input read from and written to its cache, output, and dollars. */
export type TraceUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

/** One message of a request, as text: a user's, the model's own, or a tool's result. */
export type TraceMessage = { role: 'user' | 'assistant' | 'toolResult' | 'system'; text: string; tool?: string; chars: number };

type SpanBase = {
	id: string;
	/** Whose conversation: `main` for the agent, else the subagent run's id. */
	lane: string;
	/** Milliseconds from the reply's start. */
	start: number;
	durationMs: number;
	error: string | null;
};

export type ModelSpan = SpanBase & {
	kind: 'model';
	/** `agent`, or one of compaction's summaries. */
	purpose: string;
	model: string;
	usage: TraceUsage | null;
	/** The request's parts in estimated tokens, scaled to what the provider counted. */
	parts: Record<TracePart, number>;
	/** Messages the request carried. */
	messages: number;
	/** Messages new since this conversation's previous call: what this call added to the context. */
	added: TraceMessage[];
	/** How many more were added than are kept in `added`. */
	addedMore: number;
	/** Keys into the trace's `prompts` and `toolsets`, so a changed prefix (the cache's undoing) can be seen. */
	prompt: string;
	toolset: string;
	output: { text: string; thinking: string; toolCalls: Array<{ id: string; name: string }> };
	finish: string | null;
};

export type ToolSpan = SpanBase & {
	kind: 'tool';
	tool: string;
	/** The call's arguments, as JSON. */
	input: string;
	output: string;
	/** The output's whole length, before it was cut to keep. */
	outputChars: number;
};

export type AgentSpan = SpanBase & {
	kind: 'agent';
	agent: string;
	/** The lane the agent was started from, and the `task` call that started it. */
	parent: string;
	call: string | null;
	description: string | null;
	prompt: string;
	result: string;
};

export type CompactionSpan = SpanBase & {
	kind: 'compaction';
	reason: string | null;
	tokensBefore: number | null;
	messagesBefore: number | null;
	messagesAfter: number | null;
};

export type TraceSpan = ModelSpan | ToolSpan | AgentSpan | CompactionSpan;

export type Trace = {
	id: string;
	sessionId: string;
	startedAt: string;
	durationMs: number;
	/** The agent's own model. */
	model: string | null;
	spans: TraceSpan[];
	/** System prompts by key, each as sent (cut past a size), and the tools each call offered. */
	prompts: Record<string, string>;
	toolsets: Record<string, Array<{ name: string; tokens: number }>>;
	/** Spans left out once the trace held as many as it keeps. */
	dropped: number;
};

/** What a call's input was, by where it came from: read from the cache, written to it, or sent fresh. */
export function cacheShare(usage: TraceUsage): { total: number; read: number; write: number; fresh: number; hit: number } {
	const total = usage.input + usage.cacheRead + usage.cacheWrite;
	return { total, read: usage.cacheRead, write: usage.cacheWrite, fresh: usage.input, hit: total ? usage.cacheRead / total : 0 };
}

export type CacheVerdict = { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string; why: string };

/**
 * Why a call hit or missed the provider's cache, against the call before it in
 * the same conversation. A cache keys on the request's prefix (system prompt,
 * tools, then messages in order), so a changed prompt or tool list undoes it;
 * a prefix that held and still missed points at the cache expiring, or a
 * provider that caches nothing.
 */
export function cacheVerdict(span: ModelSpan, previous: ModelSpan | null): CacheVerdict {
	if (!span.usage) return { tone: 'neutral', label: 'No usage', why: 'The provider reported no tokens for this call.' };
	const { hit, total, read, write } = cacheShare(span.usage);
	const changed = previous ? [previous.prompt !== span.prompt && 'system prompt', previous.toolset !== span.toolset && 'tool list'].filter(Boolean) : [];
	const percent = `${Math.round(hit * 100)}%`;
	if (!total) return { tone: 'neutral', label: 'No input', why: 'Nothing was sent.' };
	if (changed.length) {
		return {
			tone: read ? 'warning' : 'danger',
			label: read ? `Partial · ${percent}` : 'Miss',
			why: `The ${changed.join(' and ')} changed since the previous call, so the cached prefix no longer matched${read ? ' past the part that stayed the same' : ''}.`,
		};
	}
	if (hit >= 0.6) return { tone: 'success', label: `Hit · ${percent}`, why: `${percent} of the input was read from the provider's cache, at a lower price.` };
	if (!previous) {
		return write
			? { tone: 'neutral', label: 'Written', why: "The conversation's first call: its prefix was written to the cache for the calls after it." }
			: read
				? { tone: 'warning', label: `Partial · ${percent}`, why: `Part of the prefix was cached from an earlier reply; the rest was sent fresh.` }
				: { tone: 'neutral', label: 'Cold', why: "The conversation's first call in this reply: nothing of it was cached yet, or the provider reports no cache." };
	}
	if (read) return { tone: 'warning', label: `Partial · ${percent}`, why: 'The prefix held, but much of the input was new: long tool results or messages were added since the previous call.' };
	return {
		tone: 'danger',
		label: 'Miss',
		why: 'The prefix held but nothing was read from the cache: it expired between calls, or this provider or model does not cache.',
	};
}

/** Short, readable names for the request's parts. */
export const PART_LABELS: Record<TracePart, string> = {
	systemPrompt: 'System prompt',
	skills: 'Skills',
	tools: 'Tools',
	mcpTools: 'MCP tools',
	messages: 'Messages',
};
