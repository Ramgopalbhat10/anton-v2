import { type ModelCatalog, type ModelInfo, REASONING_LEVELS, type Reasoning } from '../../core/ports.ts';

export type OpenRouterOptions = { apiUrl: string; ttlMs: number };

/** The fields Anton reads from OpenRouter's `GET /models`. */
export type OpenRouterModel = {
	id: string;
	name: string;
	description?: string;
	created?: number;
	context_length?: number | null;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	pricing?: { prompt?: string; completion?: string };
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

/** Agent work needs live tool calls and text out; batch-only variants and other models are left out. */
export function isAgentModel(model: OpenRouterModel): boolean {
	const out = model.architecture?.output_modalities ?? ['text'];
	return Boolean(model.supported_parameters?.includes('tools')) && out.includes('text') && !model.id.endsWith(':batch');
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
		price: { input: perMillion(model.pricing?.prompt), output: perMillion(model.pricing?.completion) },
		vision: model.architecture?.input_modalities?.includes('image') ?? false,
		reasoning,
		defaultReasoning: defaultLevel(model, reasoning),
	};
}

/**
 * OpenRouter's public model list, cached for `ttlMs`. A failed refresh keeps
 * serving the last good list, so a gateway hiccup never empties the picker.
 */
export function openRouterCatalog({ apiUrl, ttlMs }: OpenRouterOptions): ModelCatalog {
	let cached: { at: number; models: Promise<ModelInfo[]> } | undefined;

	async function fetchModels(): Promise<ModelInfo[]> {
		const response = await fetch(`${apiUrl}/models`);
		if (!response.ok) throw new Error(`OpenRouter /models: ${response.status}`);
		const { data } = (await response.json()) as { data: OpenRouterModel[] };
		return data.filter(isAgentModel).map(toModelInfo);
	}

	return {
		name: 'openrouter',
		list() {
			if (cached && Date.now() - cached.at < ttlMs) return cached.models;
			const previous = cached?.models;
			const models = fetchModels().catch((error: unknown) => (previous ? previous : Promise.reject(error)));
			cached = { at: Date.now(), models };
			// A failure with nothing to fall back on is retried on the next call.
			models.catch(() => (cached = undefined));
			return models;
		},
	};
}
