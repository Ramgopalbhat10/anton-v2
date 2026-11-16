import { madeByOpenAi } from './tool-profile.ts';
import { cacheShare, cacheVerdict, type CacheVerdict, type ModelSpan, type Trace } from './trace.ts';

const MINUTE = 60_000;

/** pi-ai asks for short retention unless given `cacheRetention: 'long'`, which Anton never sets; the ChatGPT plan drops `prompt_cache_retention`. */
export const CACHE_LIFETIMES = {
	// Five minutes from the last read, each hit restarting it; pi-ai sends `cache_control` with no `ttl`.
	anthropic: 5 * MINUTE,
	// OpenAI keeps a prefix five to ten minutes idle, at times an hour off-peak: ten, so a shorter gap is not treated as cold.
	openai: 10 * MINUTE,
};
/** The shortest of the common ones. */
export const DEFAULT_CACHE_MS = 5 * MINUTE;

/** By the model's maker: a gateway passes OpenAI's and Anthropic's models on to them, and the cache is theirs. */
export function cacheLifetime(model: string): number {
	if (madeByOpenAi(model)) return CACHE_LIFETIMES.openai;
	if (/claude/i.test(model)) return CACHE_LIFETIMES.anthropic;
	return DEFAULT_CACHE_MS;
}

export type CacheCall = Pick<ModelSpan, 'model' | 'usage' | 'prompt' | 'toolset'> & {
	task: string;
	reply: string;
	/** 1-based, within its reply. */
	number: number;
	/** Epoch milliseconds. */
	start: number;
	end: number;
	compacted: boolean;
};

/** From the most telling cause down. */
export const MISS_CLASSES = ['prompt changed', 'tools changed', 'model changed', 'compacted', 'pruned', 'expired', 'older prefix', 'provider miss'] as const;
export type MissClass = (typeof MISS_CLASSES)[number];

export type CacheMiss = { call: CacheCall; previous: CacheCall; next: CacheCall | null; gapMs: number; class: MissClass; verdict: CacheVerdict };

/** A previous call smaller than this wrote little worth reading back. */
const MISS_FROM = 4_000;
/** A conversation sent this much smaller than the call before, with no compaction, had old results cleared from it. */
const SHRUNK = 0.9;

const inputOf = (call: CacheCall) => (call.usage ? cacheShare(call.usage).total : 0);

/** A miss reads less than half of what the previous call sent (or of its own input, if smaller) from the cache, after a previous call over 4,000 tokens. */
export function missClass(call: CacheCall, previous: CacheCall): MissClass | null {
	if (!call.usage || !previous.usage) return null;
	const before = inputOf(previous);
	const { total, read } = cacheShare(call.usage);
	if (before <= MISS_FROM || !total || read >= Math.min(before, total) / 2) return null;
	if (call.prompt !== previous.prompt) return 'prompt changed';
	if (call.toolset !== previous.toolset) return 'tools changed';
	if (call.model !== previous.model) return 'model changed';
	if (call.compacted) return 'compacted';
	if (total < before * SHRUNK) return 'pruned';
	if (call.start - previous.end >= cacheLifetime(call.model)) return 'expired';
	return read ? 'older prefix' : 'provider miss';
}

export function cacheMisses(calls: CacheCall[]): CacheMiss[] {
	const misses: CacheMiss[] = [];
	for (let index = 1; index < calls.length; index++) {
		const [previous, call] = [calls[index - 1], calls[index]];
		const kind = missClass(call, previous);
		if (kind) misses.push({ call, previous, next: calls[index + 1] ?? null, gapMs: call.start - previous.end, class: kind, verdict: cacheVerdict(call, previous) });
	}
	return misses;
}

export type MissTally = { calls: number; misses: number; byClass: Partial<Record<MissClass, number>>; uncached: number };
export type MissSummary = MissTally & { models: Array<MissTally & { model: string }> };

export function missSummary(conversations: CacheCall[][]): MissSummary {
	const empty = (): MissTally => ({ calls: 0, misses: 0, byClass: {}, uncached: 0 });
	const all = empty();
	const models = new Map<string, MissTally>();
	const tallyOf = (model: string) => models.get(model) ?? models.set(model, empty()).get(model)!;
	for (const calls of conversations) {
		for (const call of calls) {
			all.calls++;
			tallyOf(call.model).calls++;
		}
		for (const miss of cacheMisses(calls)) {
			const uncached = inputOf(miss.call) - (miss.call.usage?.cacheRead ?? 0);
			for (const tally of [all, tallyOf(miss.call.model)]) {
				tally.misses++;
				tally.byClass[miss.class] = (tally.byClass[miss.class] ?? 0) + 1;
				tally.uncached += uncached;
			}
		}
	}
	return { ...all, models: [...models].map(([model, tally]) => ({ model, ...tally })).sort((a, b) => b.calls - a.calls) };
}

/** Calls that sent nothing touch no cache and are left out; so are subagents and compaction's summaries, which have their own conversations. */
export function callsFromTraces(task: string, traces: Trace[]): CacheCall[] {
	const calls: CacheCall[] = [];
	let compacted = false;
	for (const trace of traces) {
		const started = Date.parse(trace.startedAt);
		const spans = trace.spans.filter((span) => span.lane === 'main' && (span.kind === 'compaction' || (span.kind === 'model' && span.purpose === 'agent')));
		let number = 0;
		for (const span of spans.sort((a, b) => a.start - b.start)) {
			if (span.kind === 'compaction') compacted = true;
			if (span.kind !== 'model' || !span.usage || !cacheShare(span.usage).total) continue;
			calls.push({ task, reply: trace.id, number: ++number, model: span.model, usage: span.usage, prompt: span.prompt, toolset: span.toolset, start: started + span.start, end: started + span.start + span.durationMs, compacted });
			compacted = false;
		}
	}
	return calls;
}
