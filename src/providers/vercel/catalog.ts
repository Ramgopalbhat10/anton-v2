import { type ModelCatalog, type ModelEndpoint, type ModelInfo, REASONING_LEVELS, type Reasoning } from '../../core/ports.ts';
import { cachedEndpoints, cachedList } from '../cached-list.ts';

/** `apiKey` is read on each listing, so a new key lists the models again; the list itself needs none. */
export type VercelOptions = { apiUrl: string; ttlMs: number; apiKey?: () => string | null };

/** The fields Anton reads from Vercel AI Gateway's `GET /v1/models` (vercel.com/docs/ai-gateway/sdks-and-apis/rest-api). */
export type VercelModel = {
	id: string;
	name?: string;
	description?: string;
	owned_by?: string;
	released?: number;
	created?: number;
	context_window?: number | null;
	max_tokens?: number | null;
	type?: string;
	tags?: string[];
	modalities?: { input?: string[]; output?: string[] };
	reasoning_options?: Array<{ type?: string; values?: string[] }> | null;
	pricing?: { input?: string; output?: string; input_cache_read?: string; input_cache_write?: string } | null;
};

/** How the model list names each maker, by the vendor part of its id. */
const VENDORS: Record<string, string> = {
	alibaba: 'Alibaba',
	amazon: 'Amazon',
	anthropic: 'Anthropic',
	'arcee-ai': 'Arcee AI',
	bytedance: 'ByteDance',
	cohere: 'Cohere',
	deepseek: 'DeepSeek',
	google: 'Google',
	meituan: 'Meituan',
	meta: 'Meta',
	minimax: 'MiniMax',
	mistral: 'Mistral',
	moonshotai: 'Moonshot AI',
	nvidia: 'NVIDIA',
	openai: 'OpenAI',
	perplexity: 'Perplexity',
	spacexai: 'xAI',
	xai: 'xAI',
	xiaomi: 'Xiaomi',
	zai: 'Z.ai',
};

const vendorOf = (model: VercelModel): string => {
	const slug = model.owned_by ?? model.id.split('/')[0];
	return VENDORS[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ');
};

/** Offered when a model reasons but lists no efforts, or only a switch or a budget. */
const STANDARD: Reasoning[] = ['off', 'low', 'medium', 'high'];

const asLevel = (effort: string): Reasoning | undefined => REASONING_LEVELS.find((level) => level === (effort === 'none' ? 'off' : effort));

/** The efforts it lists, with off when it can be switched off; a model that must reason has no off. */
export function reasoningLevels(model: VercelModel): Reasoning[] {
	const options = model.reasoning_options ?? [];
	if (!options.length && !model.tags?.includes('reasoning')) return [];
	const listed = options.flatMap((option) => (option.type === 'effort' ? (option.values ?? []) : [])).map(asLevel);
	const efforts = listed.filter((level) => level !== undefined);
	const switchable = options.some((option) => option.type === 'toggle') || efforts.includes('off') || !options.length;
	const levels = efforts.some((level) => level !== 'off') ? efforts : STANDARD;
	return REASONING_LEVELS.filter((level) => levels.includes(level) && (level !== 'off' || switchable));
}

/** Medium where it has it, as a coding agent wants some thought, else its gentlest effort. */
function defaultLevel(levels: Reasoning[]): Reasoning {
	if (levels.includes('medium')) return 'medium';
	return levels.find((level) => level !== 'off') ?? 'off';
}

const perMillion = (price: string | undefined) => Math.max(0, Number(price ?? 0) * 1_000_000);

/** The first sentence, so the list stays small enough to send whole. */
const summary = (text: string) => (/^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text).slice(0, 200);

/** Agent work needs a language model that calls tools, writes text and has a known price; batch-only ones are left out. */
export function isAgentModel(model: VercelModel): boolean {
	const priced = [model.pricing?.input, model.pricing?.output].every((price) => price !== undefined && Number(price) >= 0);
	return model.type === 'language' && Boolean(model.tags?.includes('tool-use')) && (model.modalities?.output ?? ['text']).includes('text') && priced && !model.id.endsWith('-batch');
}

export function toModelInfo(model: VercelModel): ModelInfo {
	const reasoning = reasoningLevels(model);
	const pricing = model.pricing ?? {};
	const input = perMillion(pricing.input);
	return {
		id: `vercel/${model.id}`,
		name: model.name ?? model.id.split('/').slice(1).join('/'),
		vendor: vendorOf(model),
		description: summary(model.description ?? ''),
		createdAt: (model.released ?? model.created ?? 0) * 1000,
		contextLength: model.context_window ?? 0,
		maxOutput: model.max_tokens ?? null,
		price: {
			input,
			output: perMillion(pricing.output),
			// A cache price the model does not list is charged like any prompt token.
			cacheRead: pricing.input_cache_read === undefined ? input : perMillion(pricing.input_cache_read),
			cacheWrite: pricing.input_cache_write === undefined ? input : perMillion(pricing.input_cache_write),
		},
		vision: model.modalities?.input?.includes('image') ?? model.tags?.includes('vision') ?? false,
		reasoning,
		defaultReasoning: defaultLevel(reasoning),
	};
}

/** The fields Anton reads from `GET /v1/models/{id}/endpoints`. */
type VercelEndpoint = {
	provider_name?: string;
	context_length?: number | null;
	pricing?: { prompt?: string; completion?: string };
	supported_parameters?: string[];
	uptime_last_1h?: number | null;
	latency_last_1h?: { p50?: number } | null;
	throughput_last_1h?: { p50?: number } | null;
};

/** The providers that serve a model, by the slug `providerOptions.gateway.order` takes. Those that cannot call tools are left out. */
export function toEndpoints(body: unknown): ModelEndpoint[] {
	const endpoints = ((body as { data?: { endpoints?: VercelEndpoint[] } } | null)?.data?.endpoints ?? []).filter(
		(endpoint) => endpoint.provider_name && (!endpoint.supported_parameters || endpoint.supported_parameters.includes('tools')),
	);
	return endpoints.map((endpoint) => {
		const latency = endpoint.latency_last_1h?.p50;
		return {
			slug: endpoint.provider_name!,
			name: endpoint.provider_name!,
			price: { input: perMillion(endpoint.pricing?.prompt), output: perMillion(endpoint.pricing?.completion) },
			contextLength: endpoint.context_length ?? 0,
			// The gateway reports latency in milliseconds.
			latency: typeof latency === 'number' ? latency / 1000 : null,
			throughput: typeof endpoint.throughput_last_1h?.p50 === 'number' ? endpoint.throughput_last_1h.p50 : null,
			uptime: typeof endpoint.uptime_last_1h === 'number' ? endpoint.uptime_last_1h : null,
		};
	});
}

/**
 * Vercel AI Gateway's models, cached for `ttlMs` (`cachedList`). The list is
 * the same for every key, so it is public; a key changes only who pays.
 */
export function vercelCatalog({ apiUrl, ttlMs, apiKey = () => null }: VercelOptions): ModelCatalog {
	async function fetchModels(): Promise<ModelInfo[]> {
		// Bounded, as a task's first list waits for it.
		const response = await fetch(`${apiUrl}/v1/models`, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`Vercel AI Gateway /v1/models: ${response.status}`);
		return ((await response.json()) as { data: VercelModel[] }).data.filter(isAgentModel).map(toModelInfo);
	}

	const endpoints = cachedEndpoints(async (model) => {
		const id = model.slice('vercel/'.length);
		const response = await fetch(`${apiUrl}/v1/models/${id}/endpoints`, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`Vercel AI Gateway ${id} endpoints: ${response.status}`);
		return toEndpoints(await response.json());
	});

	return { name: 'vercel', list: cachedList({ ttlMs, apiKey, fetchModels }), endpoints };
}
