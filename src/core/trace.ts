export type TracePart = 'systemPrompt' | 'skills' | 'tools' | 'mcpTools' | 'messages';
export const TRACE_PARTS: TracePart[] = ['systemPrompt', 'skills', 'tools', 'mcpTools', 'messages'];

export type TraceUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export type TraceMessage = { role: 'user' | 'assistant' | 'toolResult' | 'system'; text: string; tool?: string; chars: number };

type SpanBase = {
	id: string;
	/** `main` for the agent, else the subagent run's id. */
	lane: string;
	/** Milliseconds from the reply's start. */
	start: number;
	durationMs: number;
	error: string | null;
};

export type ModelSpan = SpanBase & {
	kind: 'model';
	purpose: string;
	model: string;
	served: string | null;
	usage: TraceUsage | null;
	/** Estimated tokens, scaled to what the provider counted. */
	parts: Record<TracePart, number>;
	messages: number;
	/** New since this conversation's previous call. */
	added: TraceMessage[];
	addedMore: number;
	/** Keys into the trace's `prompts` and `toolsets`. */
	prompt: string;
	toolset: string;
	output: { text: string; thinking: string; toolCalls: Array<{ id: string; name: string }> };
	finish: string | null;
};

export type ToolSpan = SpanBase & {
	kind: 'tool';
	tool: string;
	input: string;
	output: string;
	/** Before it was cut. */
	outputChars: number;
};

export type AgentSpan = SpanBase & {
	kind: 'agent';
	agent: string;
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
	model: string | null;
	spans: TraceSpan[];
	prompts: Record<string, string>;
	toolsets: Record<string, Array<{ name: string; tokens: number }>>;
	dropped: number;
	/** A reply the runtime resumed after a restart: what came before is not in it. */
	resumed?: boolean;
	/** A reply that failed or was stopped: its finish hook never ran, so what it would have put on the reply's message is kept here, found by the submissions it settled. */
	settled?: SettledReply;
};

export type SettledReply = { submissions: string[]; outcome: 'failed' | 'aborted'; metadata: Record<string, unknown> };

export function cacheShare(usage: TraceUsage): { total: number; read: number; write: number; fresh: number; hit: number } {
	const total = usage.input + usage.cacheRead + usage.cacheWrite;
	return { total, read: usage.cacheRead, write: usage.cacheWrite, fresh: usage.input, hit: total ? usage.cacheRead / total : 0 };
}

export type CacheVerdict = { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string; why: string };

/** A cache keys on the request's prefix (system prompt, tools, then messages), so a changed prompt or tool list undoes it. */
export function cacheVerdict(span: Pick<ModelSpan, 'usage' | 'prompt' | 'toolset'>, previous: Pick<ModelSpan, 'prompt' | 'toolset'> | null): CacheVerdict {
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

export const PART_LABELS: Record<TracePart, string> = {
	systemPrompt: 'System prompt',
	skills: 'Skills',
	tools: 'Tools',
	mcpTools: 'MCP tools',
	messages: 'Messages',
};
