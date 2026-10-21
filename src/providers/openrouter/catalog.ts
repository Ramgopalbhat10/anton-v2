import { type ModelCatalog, type ModelInfo, REASONING_LEVELS, type Reasoning } from '../../core/ports.ts';

/** `apiKey` is read on each listing; with one, the list is the models the key may use. */
export type OpenRouterOptions = { apiUrl: string; ttlMs: number; apiKey?: () => string | null };

/** The fields Anton reads from OpenRouter's `GET /models`. */
export type OpenRouterModel = {
	id: string;
	name: string;
	description?: string;
	created?: number;
	context_length?: number | null;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
	top_provider?: { max_completion_tokens?: number | null };
	supported_parameters?: string[];
	reasoning?: { mandatory?: boolean; default_enabled?: boolean; supported_efforts?: string[]; default_effort?: string } | null;
};

/** Offered when a model reasons but does not list its efforts. */
const STANDARD: Reasoning[] = ['off', 'low', 'medium', 'high'];

const asLevel = (effort: string): Reasoning | undefined => REASONING_LEVELS.find((level) => level === (effort === 'none' ? 'off' : effort));

function reasoningLevels(model: OpenRouterModel): Reasoning[] {
	if (!model.supported_parameters?.includes('reasoning')) return [];
	const listed = (model.reasoning?.supported_efforts ?? []).map(asLevel).filter((level) => level !== undefined);
	const levels = listed.length ? listed : STANDARD;
	const mandatory = model.reasoning?.mandatory === true;
	return REASONING_LEVELS.filter((level) => levels.includes(level) && !(mandatory && level === 'off'));
}

function defaultLevel(model: OpenRouterModel, levels: Reasoning[]): Reasoning {
	const preferred = asLevel(model.reasoning?.default_effort ?? '') ?? (model.reasoning?.default_enabled ? 'medium' : 'off');
	if (levels.includes(preferred)) return preferred;
	return levels.find((level) => level !== 'off') ?? 'off';
}

/** "DeepSeek: DeepSeek Flash Latest" → vendor "DeepSeek", name "DeepSeek Flash Latest". */
function splitName(model: OpenRouterModel): { vendor: string; name: string } {
	const [vendor, ...rest] = model.name.split(': ');
	return rest.length ? { vendor, name: rest.join(': ') } : { vendor: model.id.replace(/^~/, '').split('/')[0], name: model.name };
}

/** The first sentence, so the list stays small enough to send whole. */
const summary = (text: string) => (/^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text).slice(0, 200);

const perMillion = (price: string | undefined) => Math.max(0, Number(price ?? 0) * 1_000_000);

/** A cache price the model does not list is charged like any prompt token. */
function prices(pricing: NonNullable<OpenRouterModel['pricing']>): ModelInfo['price'] {
	const input = perMillion(pricing.prompt);
	return {
		input,
		output: perMillion(pricing.completion),
		cacheRead: pricing.input_cache_read === undefined ? input : perMillion(pricing.input_cache_read),
		cacheWrite: pricing.input_cache_write === undefined ? input : perMillion(pricing.input_cache_write),
	};
}

/**
 * A router such as Jev Router lists its price as -1, meaning it depends on the
 * model it picks. Anton prices every call from the list, so it could not count
 * such a model's spend against the caps.
 */
const unpriced = (model: OpenRouterModel) => [model.pricing?.prompt, model.pricing?.completion].some((price) => Number(price ?? 0) < 0);

/** Agent work needs live tool calls, text out and a known price; batch-only variants and other models are left out. */
export function isAgentModel(model: OpenRouterModel): boolean {
	const out = model.architecture?.output_modalities ?? ['text'];
	return Boolean(model.supported_parameters?.includes('tools')) && out.includes('text') && !model.id.endsWith(':batch') && !unpriced(model);
}

export function toModelInfo(model: OpenRouterModel): ModelInfo {
	const reasoning = reasoningLevels(model);
	return {
		id: `openrouter/${model.id}`,
		...splitName(model),
		description: summary(model.description ?? ''),
		createdAt: (model.created ?? 0) * 1000,
		contextLength: model.context_length ?? 0,
		maxOutput: model.top_provider?.max_completion_tokens ?? null,
		price: prices(model.pricing ?? {}),
		vision: model.architecture?.input_modalities?.includes('image') ?? false,
		reasoning,
		defaultReasoning: defaultLevel(model, reasoning),
	};
}

/** After a refresh in the background fails, how long the last list is served before asking again. */
const RETRY_MS = 5 * 60_000;

/**
 * OpenRouter's model list, cached for `ttlMs`. With a key it is the models the
 * key's account may use (`/models/user`, after its provider preferences and
 * guardrails), else the public list, which also stands in when that call
 * fails. Once the hour is up the last list is still served at once while a
 * new one is fetched behind it, so the picker never waits on OpenRouter; a
 * failed refresh keeps serving the last good list, so a gateway hiccup never
 * empties the picker; a new key lists them again at once.
 */
export function openRouterCatalog({ apiUrl, ttlMs, apiKey = () => null }: OpenRouterOptions): ModelCatalog {
	type Entry = { at: number; key: string | null; models: Promise<ModelInfo[]>; settled: boolean };
	let cached: Entry | undefined;
	let refreshing: Promise<unknown> | null = null;

	async function fetchList(path: string, key: string | null): Promise<OpenRouterModel[]> {
		// Bounded, as a task's first list waits for it.
		const response = await fetch(`${apiUrl}${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`OpenRouter ${path}: ${response.status}`);
		return ((await response.json()) as { data: OpenRouterModel[] }).data;
	}

	async function fetchModels(key: string | null): Promise<ModelInfo[]> {
		const data = key ? await fetchList('/models/user', key).catch(() => fetchList('/models', null)) : await fetchList('/models', null);
		return data.filter(isAgentModel).map(toModelInfo);
	}

	/** The last good list stays served until a newer one is in hand. */
	function refreshBehind(entry: Entry) {
		if (refreshing) return;
		refreshing = fetchModels(entry.key)
			.then(
				(models) => {
					if (cached === entry) cached = { at: Date.now(), key: entry.key, models: Promise.resolve(models), settled: true };
				},
				() => {
					if (cached === entry) entry.at = Date.now() - ttlMs + RETRY_MS;
				},
			)
			.finally(() => (refreshing = null));
	}

	return {
		name: 'openrouter',
		list(fresh = false) {
			const key = apiKey();
			const current = cached?.key === key ? cached : undefined;
			if (!fresh && current && Date.now() - current.at < ttlMs) return current.models;
			if (!fresh && current?.settled) {
				refreshBehind(current);
				return current.models;
			}
			const previous = cached?.models;
			const models = fetchModels(key).catch((error: unknown) => (previous ? previous : Promise.reject(error)));
			const entry: Entry = { at: Date.now(), key, models, settled: false };
			cached = entry;
			models.then(
				() => (entry.settled = true),
				// A failure with nothing to fall back on is retried on the next call.
				() => cached === entry && (cached = undefined),
			);
			return models;
		},
	};
}
