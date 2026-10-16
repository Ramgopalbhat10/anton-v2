/**
 * A plan's model can come in variants the vendor offers beside its standard
 * one: a larger context window, a fast mode, or both. Each is a model of its
 * own to the agents, named the way Claude Code names its 1M models: the
 * vendor's id with `[1m]` (the larger context, by its size) or `[fast]` after
 * it. The model list marks each with the model it is a variant of
 * (`variant`), and the model picker shows it as that model's context and
 * Fast controls rather than a row of its own.
 */
export type ModelVariant = { base: string; context: string | null; fast: boolean };

/** What makes a listed model a variant: the model it is one of, its larger context (null when the same), and fast mode. */
export type VariantOf = { of: string; context: string | null; fast: boolean };

type Listed = { id: string; name: string; description: string; contextLength: number };

/**
 * The model and its variants: at the larger context, in fast mode, and both,
 * each with its id, name, context and what it costs said in its description.
 */
export function withVariants<T extends Listed>(
	model: T,
	options: { context?: { tag: string; tokens: number; description: string } | null; fast?: { description: string; change?: Partial<T> } | null },
): T[] {
	const { context, fast } = options;
	const models = [model];
	if (context && context.tokens > model.contextLength) {
		models.push({
			...model,
			id: variantId(model.id, { context: context.tag }),
			name: variantName(model.name, { context: context.tag }),
			description: context.description,
			contextLength: context.tokens,
		});
	}
	if (fast) {
		for (const at of [...models]) {
			models.push({
				...at,
				...fast.change,
				id: variantId(at.id, { fast: true }),
				name: variantName(at.name, { fast: true }),
				description: at === model ? fast.description : `${at.description} ${fast.description}`,
			});
		}
	}
	return models;
}

/**
 * Marks each listed variant with the model it is one of: its id without the
 * suffixes, or, when only the larger context is listed (a Claude plan that
 * serves its Opus at 1M alone), that one. A variant whose model is not
 * listed stays a model of its own.
 */
export function linkVariants<T extends { id: string; variant?: VariantOf }>(models: T[]): T[] {
	const ids = new Set(models.map((model) => model.id));
	return models.map((model) => {
		const cut = model.id.indexOf('/') + 1;
		const gateway = model.id.slice(0, cut);
		const own = parseVariant(model.id.slice(cut));
		if (!own.context && !own.fast) return model;
		const root = [variantId(own.base, {}), variantId(own.base, { context: own.context })]
			.map((id) => `${gateway}${id}`)
			.find((id) => id !== model.id && ids.has(id));
		if (!root) return model;
		const rootContext = parseVariant(root.slice(cut)).context;
		return { ...model, variant: { of: root, context: own.context === rootContext ? null : own.context, fast: own.fast } };
	});
}

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
