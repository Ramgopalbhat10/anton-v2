import { type ModelCatalog, type ModelEndpoint, type ModelInfo, REASONING_LEVELS, type Reasoning } from '../../core/ports.ts';
import { cachedEndpoints, cachedList } from '../cached-list.ts';

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

/** The fields Anton reads from OpenRouter's `GET /models/{id}/endpoints`. */
type OpenRouterEndpoint = {
	provider_name?: string;
	tag?: string;
	context_length?: number | null;
	pricing?: { prompt?: string; completion?: string };
	status?: number;
	supported_parameters?: string[];
	uptime_last_30m?: number | null;
	latency_last_30m?: { p50?: number } | number | null;
	throughput_last_30m?: { p50?: number } | number | null;
};

const median = (value: { p50?: number } | number | null | undefined): number | null =>
	typeof value === 'number' ? value : typeof value?.p50 === 'number' ? value.p50 : null;

/** The providers that serve a model, by the tag OpenRouter's `provider.order` takes. Those that cannot call tools are left out. */
export function toEndpoints(body: unknown): ModelEndpoint[] {
	const endpoints = ((body as { data?: { endpoints?: OpenRouterEndpoint[] } } | null)?.data?.endpoints ?? []).filter(
		(endpoint) => endpoint.tag && (!endpoint.supported_parameters || endpoint.supported_parameters.includes('tools')),
	);
	return endpoints.map((endpoint) => {
		const latency = median(endpoint.latency_last_30m);
		return {
			slug: endpoint.tag!,
			name: endpoint.provider_name ?? endpoint.tag!,
			price: { input: perMillion(endpoint.pricing?.prompt), output: perMillion(endpoint.pricing?.completion) },
			contextLength: endpoint.context_length ?? 0,
			// OpenRouter reports latency in milliseconds.
			latency: latency === null ? null : latency / 1000,
			throughput: median(endpoint.throughput_last_30m),
			uptime: typeof endpoint.uptime_last_30m === 'number' ? endpoint.uptime_last_30m : null,
		};
	});
}

/**
 * OpenRouter's model list, cached for `ttlMs` (`cachedList`). With a key it is
 * the models the key's account may use (`/models/user`, after its provider
 * preferences and guardrails), else the public list, which also stands in when
 * that call fails.
 */
export function openRouterCatalog({ apiUrl, ttlMs, apiKey = () => null }: OpenRouterOptions): ModelCatalog {
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

	const endpoints = cachedEndpoints(async (model) => {
		const id = model.slice('openrouter/'.length);
		const response = await fetch(`${apiUrl}/models/${id}/endpoints`, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`OpenRouter ${id} endpoints: ${response.status}`);
		return toEndpoints(await response.json());
	});

	return { name: 'openrouter', list: cachedList({ ttlMs, apiKey, fetchModels }), endpoints };
}
