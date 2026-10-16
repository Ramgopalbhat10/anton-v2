/**
 * A plan's model can come in variants the vendor offers beside its standard
 * one: a larger context window, or a fast mode. Anton lists each as a model
 * of its own, named the way Claude Code names its 1M models: the vendor's id
 * with `[1m]` (the larger context, by its size) or `[fast]` after it.
 */
export type ModelVariant = { base: string; context: string | null; fast: boolean };

const SUFFIX = /\[([a-z0-9.]+)\]$/i;

/** `claude-opus-4-7[1m]` as its base id and the 1M context; `gpt-5.5[fast]` as fast. */
export function parseVariant(id: string): ModelVariant {
	let base = id;
	let context: string | null = null;
	let fast = false;
	for (let match = base.match(SUFFIX); match; match = base.match(SUFFIX)) {
		const tag = match[1].toLowerCase();
		if (tag === 'fast') fast = true;
		else if (sizeOf(tag) !== null) context = tag;
		else break;
		base = base.slice(0, -match[0].length);
	}
	return { base, context, fast };
}

/** The id of a variant: the base id with its context, then `[fast]`. */
export function variantId(base: string, variant: { context?: string | null; fast?: boolean }): string {
	return `${base}${variant.context ? `[${variant.context}]` : ''}${variant.fast ? '[fast]' : ''}`;
}

/** "300k" as 300000 and "1m" as 1000000. */
export function sizeOf(value: string): number | null {
	const match = value.match(/^(\d+(?:\.\d+)?)([km])$/i);
	return match ? Math.round(Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000)) : null;
}

/** 1050000 as "1m" and 400000 as "400k", for a variant's id: the size rounded down, as vendors name it. */
export function sizeTag(tokens: number): string {
	if (tokens >= 1_000_000) return `${Math.floor(tokens / 100_000) / 10}m`;
	return `${Math.round(tokens / 1_000)}k`;
}

/** The variant as its name says it: "Claude Opus 4.7 · 1M", "GPT-5.5 · Fast". */
export function variantName(name: string, variant: { context?: string | null; fast?: boolean }): string {
	const parts = [variant.context ? variant.context.toUpperCase() : null, variant.fast ? 'Fast' : null].filter(Boolean);
	return parts.length ? `${name} · ${parts.join(' · ')}` : name;
}
