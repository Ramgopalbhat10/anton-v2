import type { ModelInfo, Reasoning } from './api';

export type Filter = 'reasoning' | 'vision' | 'free' | 'long';
export type Sort = 'newest' | 'cheapest' | 'context';

/** Each filter is one predicate, so adding a filter is one line. */
export const FILTERS: Record<Filter, { label: string; test: (model: ModelInfo) => boolean }> = {
	reasoning: { label: 'Reasoning', test: (model) => model.reasoning.length > 0 },
	vision: { label: 'Vision', test: (model) => model.vision },
	free: { label: 'Free', test: (model) => !model.subscription && model.price.input === 0 && model.price.output === 0 },
	long: { label: '256K+', test: (model) => model.contextLength >= 256_000 },
};

export const SORTS: Record<Sort, { label: string; compare: (a: ModelInfo, b: ModelInfo) => number }> = {
	newest: { label: 'Newest', compare: (a, b) => b.createdAt - a.createdAt },
	cheapest: { label: 'Cheapest', compare: (a, b) => a.price.output - b.price.output || a.price.input - b.price.input },
	context: { label: 'Context', compare: (a, b) => b.contextLength - a.contextLength },
};

export const NEXT_SORT: Record<Sort, Sort> = { newest: 'cheapest', cheapest: 'context', context: 'newest' };

/** Gateways by the `<gateway>` a model id starts with. */
const GATEWAYS: Record<string, string> = { openrouter: 'OpenRouter' };

/** Where a model's calls go: the plan you signed in to, such as "ChatGPT", or the gateway that lists it. */
export function sourceOf(model: ModelInfo): string {
	if (model.subscription) return model.subscription;
	const gateway = model.id.split('/')[0];
	return GATEWAYS[gateway] ?? gateway;
}

/** One tab of the picker's source switch; `plan` ones bill a subscription, and `connected` is false for a plan not signed in yet. */
export type Source = { name: string; plan: boolean; connected: boolean; count: number };

/** Plans first, connected or not, then the gateways, each with how many models it offers. */
export function sourcesOf(models: ModelInfo[], plans: Array<{ name: string; connected: boolean }> = []): Source[] {
	const counts = new Map<string, number>();
	for (const model of models) counts.set(sourceOf(model), (counts.get(sourceOf(model)) ?? 0) + 1);
	const planNames = new Set([...plans.map((plan) => plan.name), ...models.filter((model) => model.subscription).map(sourceOf)]);
	const planSources = [...planNames].map((name) => ({
		name,
		plan: true,
		connected: (counts.get(name) ?? 0) > 0 || plans.some((plan) => plan.name === name && plan.connected),
		count: counts.get(name) ?? 0,
	}));
	const gateways = [...counts].filter(([name]) => !planNames.has(name)).map(([name, count]) => ({ name, plan: false, connected: true, count }));
	return [...planSources, ...gateways];
}

/** Every word of the query must appear in the model's name, vendor or id. */
export function matches(model: ModelInfo, query: string): boolean {
	const haystack = `${model.vendor} ${model.name} ${model.id}`.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => haystack.includes(word));
}

export function visibleModels(models: ModelInfo[], query: string, filters: Set<Filter>, sort: Sort): ModelInfo[] {
	const tests = [...filters].map((filter) => FILTERS[filter].test);
	return models.filter((model) => matches(model, query) && tests.every((test) => test(model))).sort(SORTS[sort].compare);
}

export const REASONING_LABEL: Record<Reasoning, string> = {
	off: 'Off',
	minimal: 'Min',
	low: 'Low',
	medium: 'Med',
	high: 'High',
	xhigh: 'X-High',
	max: 'Max',
};

/** The level a task runs at: its choice when the model accepts it, else the model's default. */
export function effectiveReasoning(model: ModelInfo | undefined, chosen: Reasoning | null): Reasoning {
	if (!model?.reasoning.length) return 'off';
	return chosen && model.reasoning.includes(chosen) ? chosen : model.defaultReasoning;
}

/** How far along the model's own scale a level sits, 0 to 1. */
export function reasoningStrength(model: ModelInfo | undefined, level: Reasoning): number {
	const levels = (model?.reasoning ?? []).filter((item) => item !== 'off');
	if (level === 'off' || levels.length === 0) return 0;
	return (levels.indexOf(level) + 1) / levels.length;
}

/** "DeepSeek Flash Latest" by DeepSeek reads as "Flash Latest". */
export function shortName(model: ModelInfo): string {
	const trimmed = model.name.replace(new RegExp(`^${model.vendor.replace(/[^\w]/g, '\\$&')}\\s+`, 'i'), '');
	return trimmed || model.name;
}

export function tokens(count: number): string {
	if (count >= 1_000_000) return `${+(count / 1_048_576).toFixed(1)}M`;
	if (count >= 1000) return `${Math.round(count / 1000)}K`;
	return String(count);
}

export function dollars(perMillion: number): string {
	if (perMillion === 0) return '$0';
	return perMillion < 1 ? `$${+perMillion.toFixed(3)}` : `$${+perMillion.toFixed(2)}`;
}

/** 0 for free through 4 for the most expensive tier, on output price per million tokens. */
export function costTier(model: ModelInfo): number {
	const price = model.price.output;
	return [0, 1, 5, 20].filter((step) => price > step).length;
}

const HUES = ['#B98BE8', '#8FC98D', '#E0AC63', '#DCC98A', '#E58FA8', '#6fcde8', '#f2c173', '#9ee1f3'];

/** A stable hue per vendor, so a vendor's models read as one family in the list. */
export function vendorHue(vendor: string): string {
	let hash = 0;
	for (const char of vendor) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return HUES[hash % HUES.length];
}

const RECENT_KEY = 'anton.recentModels';

export function recentModels(): string[] {
	try {
		return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
	} catch {
		return [];
	}
}

export function rememberModel(id: string): void {
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentModels().filter((item) => item !== id)].slice(0, 4)));
	} catch {
		// Recents are a convenience; the picker works without them.
	}
}
