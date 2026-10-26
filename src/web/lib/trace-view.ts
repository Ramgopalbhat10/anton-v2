import type { AgentSpan, ModelSpan, ToolSpan, Trace, TraceSpan } from '../../core/trace';

/*
 * A reply's trace laid out for the trace modal: a tree of the agent's calls,
 * each subagent's opening under the `task` call that started it, flattened
 * into rows as folds and the search allow; and the reply's totals.
 */

/** Each conversation's hue: the agent's is Anton's cyan, subagents take the next data hues in the order they started. */
const LANE_HUES = ['var(--data-1)', 'var(--data-2)', 'var(--data-3)', 'var(--data-5)', 'var(--data-4)', 'var(--data-6)'];

export type TraceNode = {
	key: string;
	/** The span the row stands for; null for the agent's own row, which stands for the whole reply. */
	span: TraceSpan | null;
	/** The conversation a group row opens, for its bar's own calls. */
	group: string | null;
	lane: string;
	hue: string;
	start: number;
	end: number;
	children: TraceNode[];
};

export type TraceRow = TraceNode & { depth: number; folded: boolean; match: boolean };

/** A tool call's arguments, read back from the JSON they were kept as. */
export function parsedInput(span: ToolSpan): unknown {
	try {
		return JSON.parse(span.input);
	} catch {
		return span.input;
	}
}

/** The model's own name, without its gateway or vendor: `claude-sonnet-5.5`. */
export const shortModel = (model: string | null) => (model ? (model.split('/').at(-1) ?? model).replace(/[#[].*$/, '') : '');

export function traceTree(trace: Trace): TraceNode {
	const agents = trace.spans.filter((span): span is AgentSpan => span.kind === 'agent').sort((a, b) => a.start - b.start);
	const hues = new Map<string, string>([['main', LANE_HUES[0]]]);
	agents.forEach((agent, index) => hues.set(agent.id, LANE_HUES[(index + 1) % LANE_HUES.length]));
	const byCall = new Map(agents.flatMap((agent) => (agent.call ? [[agent.call, agent] as const] : [])));
	const placed = new Set<string>();

	function laneChildren(lane: string): TraceNode[] {
		const hue = hues.get(lane) ?? LANE_HUES[0];
		const own = trace.spans.filter((span) => span.lane === lane && span.kind !== 'agent');
		const started = agents.filter((agent) => agent.parent === lane && !(agent.call && own.some((span) => span.id === agent.call)));
		return [...own, ...started]
			.sort((a, b) => a.start - b.start)
			.map((span) => {
				const agent = span.kind === 'agent' ? span : span.kind === 'tool' && span.tool === 'task' ? byCall.get(span.id) : undefined;
				if (agent && !placed.has(agent.id)) {
					placed.add(agent.id);
					const children = laneChildren(agent.id);
					return {
						key: `agent:${agent.id}`,
						span: agent,
						group: agent.id,
						lane,
						hue: hues.get(agent.id) ?? hue,
						start: Math.min(span.start, agent.start),
						end: Math.max(span.start + span.durationMs, agent.start + agent.durationMs),
						children,
					};
				}
				return { key: `${span.kind}:${span.id}`, span, group: null, lane, hue, start: span.start, end: span.start + span.durationMs, children: [] };
			});
	}

	return { key: 'reply', span: null, group: 'main', lane: 'main', hue: LANE_HUES[0], start: 0, end: trace.durationMs, children: laneChildren('main') };
}

/** Text a search looks through for a row: its tool, arguments and output, a call's model and words, an agent's brief. */
function searchText(node: TraceNode): string {
	const span = node.span;
	if (!span) return 'anton';
	switch (span.kind) {
		case 'model':
			// Not what it was sent: every call carries the conversation, so every call would match.
			return `${span.model} ${span.output.text} ${span.output.toolCalls.map((call) => call.name).join(' ')}`;
		case 'tool':
			return `${span.tool} ${span.input} ${span.output}`;
		case 'agent':
			return `${span.agent} ${span.description ?? ''} ${span.prompt} ${span.result}`;
		default:
			return 'compaction compacted';
	}
}

/** The rows shown: folded groups hide their children; a search keeps the rows that match and the groups they are in. */
export function traceRows(root: TraceNode, folded: ReadonlySet<string>, query = ''): TraceRow[] {
	const needle = query.trim().toLowerCase();
	const rows: TraceRow[] = [];
	const matches = (node: TraceNode): boolean => searchText(node).toLowerCase().includes(needle) || node.children.some(matches);
	function walk(node: TraceNode, depth: number) {
		if (needle && !matches(node)) return;
		const shut = !needle && folded.has(node.key);
		rows.push({ ...node, depth, folded: shut, match: Boolean(needle) && searchText(node).toLowerCase().includes(needle) });
		if (!shut) for (const child of node.children) walk(child, depth + 1);
	}
	walk(root, 0);
	return rows;
}

export type TraceStats = {
	durationMs: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** The share of all input read from the cache. */
	hit: number;
	modelCalls: number;
	toolCalls: number;
	agents: number;
	errors: number;
	/** The longest tool call or model call, called out on its row. */
	slowest: string | null;
};

/** Totals over some of the trace's spans: the whole reply, or one conversation's. */
export function traceStats(trace: Trace, lane?: string): TraceStats {
	const spans = lane ? trace.spans.filter((span) => span.lane === lane) : trace.spans;
	const models = spans.filter((span): span is ModelSpan => span.kind === 'model');
	const sum = (pick: (span: ModelSpan) => number) => models.reduce((total, span) => total + pick(span), 0);
	const input = sum((span) => span.usage?.input ?? 0);
	const cacheRead = sum((span) => span.usage?.cacheRead ?? 0);
	const cacheWrite = sum((span) => span.usage?.cacheWrite ?? 0);
	const timed = spans.filter((span) => span.kind === 'model' || span.kind === 'tool');
	const slowest = timed.length > 2 ? timed.reduce((best, span) => (span.durationMs > best.durationMs ? span : best)) : null;
	const end = spans.reduce((latest, span) => Math.max(latest, span.start + span.durationMs), 0);
	const begin = spans.reduce((earliest, span) => Math.min(earliest, span.start), end);
	return {
		durationMs: lane ? end - begin : trace.durationMs,
		cost: sum((span) => span.usage?.cost ?? 0),
		input: input + cacheRead + cacheWrite,
		output: sum((span) => span.usage?.output ?? 0),
		cacheRead,
		cacheWrite,
		hit: input + cacheRead + cacheWrite ? cacheRead / (input + cacheRead + cacheWrite) : 0,
		modelCalls: models.length,
		toolCalls: spans.filter((span) => span.kind === 'tool').length,
		agents: spans.filter((span) => span.kind === 'agent').length,
		errors: spans.filter((span) => span.error).length,
		slowest: slowest?.id ?? null,
	};
}

/** The call before this one in the same conversation, which its cache is judged against. */
export function previousCall(trace: Trace, span: ModelSpan): ModelSpan | null {
	let previous: ModelSpan | null = null;
	for (const other of trace.spans) {
		if (other === span) return previous;
		if (other.kind === 'model' && other.lane === span.lane && other.purpose === span.purpose) previous = other;
	}
	return previous;
}

/** Each call's number within its conversation, from 1. */
export function callNumber(trace: Trace, span: ModelSpan): number {
	return trace.spans.filter((other) => other.kind === 'model' && other.lane === span.lane && other.start <= span.start).length;
}

/** A duration at a glance: "640ms", "1.4s", "12s", "3m 4s". */
export function seconds(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const whole = Math.round(ms / 1000);
	return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/** Ticks along the time axis: the finest round step that gives at most `most` marks after the first. */
export function timeTicks(total: number, most = 7): number[] {
	const steps = [100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 3_600_000];
	const step = steps.find((value) => total / value <= Math.max(1, most)) ?? steps.at(-1)!;
	const ticks: number[] = [];
	for (let at = 0; at <= total; at += step) ticks.push(at);
	return ticks;
}
