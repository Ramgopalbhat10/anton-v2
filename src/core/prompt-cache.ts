import { madeByOpenAi } from './tool-profile.ts';
import { cacheShare, cacheVerdict, type CacheVerdict, type ModelSpan, type Trace } from './trace.ts';

/*
 * How long a provider keeps a prompt cache, and why a model call missed it.
 * The pruner (src/services/context-prune.ts) waits on a warm cache and clears
 * freely on a cold one, so it needs the first; `npm run cache:misses` needs
 * both, to tell a miss the render caused (a changed system prompt or tool
 * list) from one the provider's cache did on its own.
 */

const MINUTE = 60_000;

/**
 * How long each vendor's cache keeps a prefix after its last use, at the retention Anton asks for. pi-ai asks for the
 * short one unless it is given `cacheRetention: 'long'` or `PI_CACHE_RETENTION=long`, neither of which Anton sets, and
 * the ChatGPT plan drops `prompt_cache_retention` from every request (src/flue/subscription-models.ts).
 */
export const CACHE_LIFETIMES = {
	// Anthropic keeps a prefix five minutes from its last read, each hit starting the five minutes again; pi-ai sends
	// `cache_control` with no `ttl`, which is that default (Anthropic's prompt caching docs).
	anthropic: 5 * MINUTE,
	// OpenAI keeps a prefix in memory for five to ten minutes of inactivity, at times up to an hour off-peak (OpenAI's
	// prompt caching guide). Ten, the most it usually holds: a gap shorter than that may still find the cache warm, so
	// the pruner does not clear as if it were cold, nor does the miss count call such a miss expired.
	openai: 10 * MINUTE,
};
/** Any other provider's: five minutes, the shortest of the common ones, as the pruner assumed of every provider before. */
export const DEFAULT_CACHE_MS = 5 * MINUTE;

/**
 * How long the cache of the model a specifier names (`<gateway>/<model>`) lasts. The cache is the vendor's that serves
 * the model, and a gateway passes OpenAI's and Anthropic's models on to them, so it goes by the model's maker.
 */
export function cacheLifetime(model: string): number {
	if (madeByOpenAi(model)) return CACHE_LIFETIMES.openai;
	if (/claude/i.test(model)) return CACHE_LIFETIMES.anthropic;
	return DEFAULT_CACHE_MS;
}

/** A model call in a conversation, from a reply's trace or a benchmark's events, as the miss count reads it. */
export type CacheCall = Pick<ModelSpan, 'model' | 'usage' | 'prompt' | 'toolset'> & {
	task: string;
	reply: string;
	/** Its number among the conversation's calls in its reply, from 1. */
	number: number;
	/** When it started and ended, in milliseconds since the epoch. */
	start: number;
	end: number;
	/** Whether the conversation was compacted since the call before it. */
	compacted: boolean;
};

/**
 * Why a call missed, from the most telling cause down. Each refines what `cacheVerdict` says of the call: a changed
 * prompt or tool list is its own verdict, `older prefix` is its Partial, and the rest its Miss or Partial with the
 * prefix held, told apart by what the trace knows besides (the model, a compaction, a context that shrank, the gap).
 */
export const MISS_CLASSES = ['prompt changed', 'tools changed', 'model changed', 'compacted', 'pruned', 'expired', 'older prefix', 'provider miss'] as const;
export type MissClass = (typeof MISS_CLASSES)[number];

export type CacheMiss = { call: CacheCall; previous: CacheCall; next: CacheCall | null; gapMs: number; class: MissClass; verdict: CacheVerdict };

/** A previous call smaller than this wrote little worth reading back. */
const MISS_FROM = 4_000;
/** A conversation sent this much smaller than the call before, with no compaction, had old results cleared from it. */
const SHRUNK = 0.9;

const inputOf = (call: CacheCall) => (call.usage ? cacheShare(call.usage).total : 0);

/**
 * Why `call` missed the cache after `previous`, the call before it in the same conversation; null when it did not
 * miss. A miss reads less than half of what the previous call sent (or of its own input, if that is smaller) from the
 * cache, the previous call having sent over 4,000 tokens.
 */
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

/** The calls that missed in one conversation's calls, in order, each with the calls either side and its trace verdict. */
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

/** Calls, misses, misses by class and the input the misses sent uncached, in all and for each model. */
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

/**
 * The main agent's calls in a task's traces, oldest reply first, as one conversation. Calls that sent nothing (a call
 * that failed before the provider counted it) touch no cache and are left out; subagents and compaction's summaries,
 * which have conversations of their own, too.
 */
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
