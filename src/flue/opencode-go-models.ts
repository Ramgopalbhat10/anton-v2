import { randomUUID } from 'node:crypto';
import { createProvider, type Model, type Provider, type ProviderStreams, type StreamOptions } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { OPENCODE_GO_MODELS } from '@earendil-works/pi-ai/providers/opencode-go.models';
import type { ModelInfo } from '../core/ports.ts';

// pi's `opencode-go` provider (0.83) sends neither a session id, which OpenCode now requires, nor a client name of its own,
// and its model list falls behind the plan's.
type GoApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses';
type GoModel = Model<GoApi>;

const GATEWAY = 'opencode-go';
const BASE_URL = 'https://opencode.ai/inference/go';
/** OpenCode asks each client to name itself rather than send its HTTP library's name. */
const CLIENT_HEADERS = { 'User-Agent': 'anton', 'x-opencode-client': 'anton' };
/** One per conversation, so OpenCode keeps it on one cache node; a request without it is refused. */
export const SESSION_HEADER = 'x-opencode-session';

const known = Object.values(OPENCODE_GO_MODELS) as GoModel[];

export function apiFor(id: string): GoApi {
	const pi = known.find((model) => model.id === id);
	if (pi) return pi.api;
	if (/^(claude-|minimax-m3|qwen3\.[78])/.test(id)) return 'anthropic-messages';
	if (/^(gpt-|grok-|muse-spark-)/.test(id)) return 'openai-responses';
	return 'openai-completions';
}

function toPiModel(info: ModelInfo): GoModel {
	const id = info.id.slice(`${GATEWAY}/`.length);
	const api = apiFor(id);
	const pi = known.find((model) => model.id === id);
	// A model newer than pi's catalog borrows the wire quirks of the last one served the same way.
	const compat = (pi ?? known.findLast((model) => model.api === api))?.compat;
	return {
		id,
		name: info.name,
		api,
		provider: GATEWAY,
		// pi's Anthropic client adds `/v1/messages` itself.
		baseUrl: api === 'anthropic-messages' ? BASE_URL : `${BASE_URL}/v1`,
		headers: CLIENT_HEADERS,
		reasoning: info.reasoning.length > 0,
		...(pi?.thinkingLevelMap ? { thinkingLevelMap: pi.thinkingLevelMap } : {}),
		input: info.vision ? ['text', 'image'] : ['text'],
		cost: info.price,
		contextWindow: info.contextLength,
		maxTokens: info.maxOutput ?? 32_768,
		...(compat ? { compat } : {}),
	} as GoModel;
}

/** A call outside a conversation gets a session id of its own. */
export function withSession(streams: ProviderStreams): ProviderStreams {
	const session = <T extends StreamOptions>(options: T | undefined): T =>
		({ ...options, headers: { ...options?.headers, [SESSION_HEADER]: options?.sessionId ?? `anton-${randomUUID()}` } }) as unknown as T;
	return {
		stream: (model, context, options) => streams.stream(model, context, session(options)),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, session(options)),
	};
}

export function openCodeGoProvider(live: () => readonly ModelInfo[], key: () => Promise<string>): Provider {
	const base = createProvider<GoApi>({
		id: GATEWAY,
		name: 'OpenCode Go',
		auth: {
			apiKey: {
				name: 'OpenCode Go key',
				resolve: async () => ({ auth: { apiKey: await key() }, source: 'Settings › Subscriptions' }),
			},
		},
		models: [],
		api: {
			'anthropic-messages': withSession(anthropicMessagesApi()),
			'openai-completions': withSession(openAICompletionsApi()),
			'openai-responses': withSession(openAIResponsesApi()),
		},
	});
	let memo: { from: readonly ModelInfo[]; models: GoModel[] } | undefined;
	function getModels(): GoModel[] {
		const current = live();
		if (memo?.from !== current) memo = { from: current, models: current.filter((info) => info.id.startsWith(`${GATEWAY}/`)).map(toPiModel) };
		return memo.models;
	}
	return { ...base, getModels } as Provider;
}
