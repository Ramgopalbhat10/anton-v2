import { createProvider, type Model, type Provider, type ProviderStreams } from '@earendil-works/pi-ai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { type ModelInfo, REASONING_LEVELS } from '../core/ports.ts';

type ResponsesModel = Model<'openai-responses'>;

const GATEWAY = 'openai';
const BASE_URL = 'https://api.openai.com/v1';

/**
 * Responses fields that Sign in with ChatGPT rejects
 * (developers.openai.com/siwc/token-sharing-open-source/preview-limitations);
 * pi 0.83 sends some of them, such as max_output_tokens on every call.
 */
const UNSUPPORTED = [
	'background',
	'conversation',
	'max_output_tokens',
	'max_tool_calls',
	'metadata',
	'moderation',
	'multi_agent',
	'prompt',
	'prompt_cache_retention',
	'prompt_cache_options',
	'previous_response_id',
	'safety_identifier',
	'temperature',
	'top_logprobs',
	'top_p',
	'truncation',
	'user',
];

/** Makes a Responses request one a ChatGPT plan token may send: streamed, unstored, and with no system-role items. */
export function forChatGptPlan(payload: unknown): unknown {
	if (!payload || typeof payload !== 'object') return payload;
	const request = { ...(payload as Record<string, unknown>) };
	for (const field of UNSUPPORTED) delete request[field];
	request.store = false;
	request.stream = true;
	if (Array.isArray(request.input)) {
		request.input = request.input.map((item) =>
			item && typeof item === 'object' && (item as { role?: unknown }).role === 'system' ? { ...item, role: 'developer' } : item,
		);
	}
	return request;
}

/** pi's Responses API, with every request passed through `forChatGptPlan` after any hook the caller set. */
function planStreams(api: ProviderStreams): ProviderStreams {
	const withPlanPayload = <T extends { onPayload?: (payload: unknown, model: Model<never>) => unknown }>(options: T | undefined): T =>
		({
			...options,
			onPayload: async (payload: unknown, model: Model<never>) => forChatGptPlan((await options?.onPayload?.(payload, model)) ?? payload),
		}) as T;
	return {
		stream: (model, context, options) => api.stream(model, context, withPlanPayload(options)),
		streamSimple: (model, context, options) => api.streamSimple(model, context, withPlanPayload(options)),
	};
}

const known = Object.values(OPENAI_MODELS) as ResponsesModel[];

function toPiModel(info: ModelInfo): ResponsesModel {
	const id = info.id.slice(`${GATEWAY}/`.length);
	const pi = known.find((model) => model.id === id);
	return {
		id,
		name: info.name,
		api: 'openai-responses',
		provider: GATEWAY,
		baseUrl: BASE_URL,
		reasoning: info.reasoning.length > 0,
		// Levels the account lists map to OpenAI's efforts ("none" is off); the rest send nothing.
		thinkingLevelMap: Object.fromEntries(REASONING_LEVELS.map((level) => [level, info.reasoning.includes(level) ? (level === 'off' ? 'none' : level) : null])),
		input: info.vision ? ['text', 'image'] : ['text'],
		cost: info.price,
		contextWindow: info.contextLength,
		maxTokens: info.maxOutput ?? 128_000,
		// The plan route has no Responses tool_search, so every tool is sent up front.
		compat: { ...(pi?.compat ?? { supportsStrictMode: true }), supportsToolSearch: false },
	};
}

/**
 * The OpenAI provider for models on a ChatGPT plan: the plan's models from
 * Anton's live list, each call authorized with a fresh token from the
 * sign-in. `live` is read on every lookup, so a sign-in needs no restart.
 */
export function chatGptPlanProvider(live: () => readonly ModelInfo[], token: () => Promise<string>): Provider {
	const base = createProvider<'openai-responses'>({
		id: GATEWAY,
		name: 'OpenAI (ChatGPT plan)',
		baseUrl: BASE_URL,
		auth: {
			apiKey: {
				name: 'Sign in with ChatGPT',
				resolve: async () => ({ auth: { apiKey: await token() }, source: 'ChatGPT sign-in' }),
			},
		},
		models: [],
		api: planStreams(openAIResponsesApi()),
	});
	let memo: { from: readonly ModelInfo[]; models: ResponsesModel[] } | undefined;
	function getModels(): ResponsesModel[] {
		const current = live();
		if (memo?.from !== current) memo = { from: current, models: current.filter((info) => info.id.startsWith(`${GATEWAY}/`)).map(toPiModel) };
		return memo.models;
	}
	return { ...base, getModels } as Provider;
}
