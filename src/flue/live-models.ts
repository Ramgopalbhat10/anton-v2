import { type Api, createProvider, type Model, type Provider, type StreamOptions } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { VERCEL_AI_GATEWAY_MODELS } from '@earendil-works/pi-ai/providers/vercel-ai-gateway.models';
import { type ModelRoute, openRouterRouting, parseRouted, vercelRouting } from '../core/model-route.ts';
import type { ModelInfo } from '../core/ports.ts';

type OpenRouterModel = Model<'openai-completions'>;

const DEFAULT_COMPAT: OpenRouterModel['compat'] = { supportsDeveloperRole: false, thinkingFormat: 'openrouter' };

function toPiModel(info: ModelInfo, catalog: readonly OpenRouterModel[]): OpenRouterModel {
	const id = info.id.slice('openrouter/'.length);
	const vendor = id.replace(/^~/, '').split('/')[0];
	// A model newer than pi's catalog borrows the wire quirks of its vendor's latest known model.
	const sibling = catalog.findLast((model) => model.id.startsWith(`${vendor}/`) && model.reasoning === info.reasoning.length > 0);
	return {
		id,
		name: `${info.vendor}: ${info.name}`,
		api: 'openai-completions',
		provider: 'openrouter',
		baseUrl: 'https://openrouter.ai/api/v1',
		reasoning: info.reasoning.length > 0,
		// Mandatory reasoning has no "off"; send nothing rather than `effort: none`.
		...(info.reasoning.length && !info.reasoning.includes('off') ? { thinkingLevelMap: { off: null } } : {}),
		input: info.vision ? ['text', 'image'] : ['text'],
		cost: info.price,
		contextWindow: info.contextLength,
		maxTokens: info.maxOutput ?? 32_768,
		compat: sibling?.compat ?? DEFAULT_COMPAT,
	};
}

/**
 * pi's OpenRouter provider, with every model from Anton's live catalog
 * added. pi's own entries win where both exist, since they carry tuned
 * wire settings, but take the live list's price. `live` is read on every lookup, so newly listed models
 * resolve without a restart, and `key` on every call, so a key pasted in
 * Settings › Subscriptions takes over from OPENROUTER_API_KEY at once.
 */
export function liveOpenRouterProvider(live: () => readonly ModelInfo[], key: () => Promise<string | null>, routes: () => Iterable<string> = () => []): Provider {
	const piProvider = openrouterProvider() as Provider<'openai-completions'>;
	const base: Provider<'openai-completions'> = {
		...piProvider,
		auth: {
			...piProvider.auth,
			apiKey: {
				name: 'OpenRouter API key',
				resolve: async () => {
					const apiKey = await key();
					return apiKey ? { auth: { apiKey }, source: 'Settings › Subscriptions' } : undefined;
				},
			},
		},
	};
	const known = base.getModels();
	const knownIds = new Set(known.map((model) => model.id));
	let memo: { from: readonly ModelInfo[]; models: OpenRouterModel[] } | undefined;
	function getModels(): OpenRouterModel[] {
		const current = live();
		if (memo?.from !== current) {
			const listed = new Map(current.map((info) => [info.id.slice('openrouter/'.length), info]));
			const added = current.filter((info) => !knownIds.has(info.id.slice('openrouter/'.length)));
			// pi's prices are as of its release and OpenRouter's change, so a known model is priced from the live list.
			const priced = known.map((model) => {
				const info = listed.get(model.id);
				return info ? { ...model, cost: info.price } : model;
			});
			memo = { from: current, models: [...priced, ...added.map((info) => toPiModel(info, known))] };
		}
		return memo.models;
	}
	return withRoutes({ ...base, getModels } as Provider, routes, (payload, route) => ({ ...payload, provider: { ...(payload.provider as object), ...openRouterRouting(route) } }));
}

type Payload = Record<string, unknown>;

/**
 * A provider whose models also resolve with a task's route
 * (`<model>#via=<provider>`, `<model>#sort=<sort>`, `src/core/model-route.ts`):
 * `routes` names the routed specifiers in use, each resolving to its model,
 * and a call on one goes out as the model itself with `addRoute` putting the
 * route in the request body. The gateway falls back to its own routing when
 * the route's provider fails, so a route never fails a call the model could
 * answer.
 */
export function withRoutes(provider: Provider, routes: () => Iterable<string>, addRoute: (payload: Payload, route: ModelRoute) => Payload): Provider {
	const prefix = `${provider.id}/`;
	function getModels(): Model<Api>[] {
		const models = provider.getModels() as Model<Api>[];
		const routed: Model<Api>[] = [];
		for (const specifier of routes()) {
			if (!specifier.startsWith(prefix)) continue;
			const id = specifier.slice(prefix.length);
			const base = models.find((model) => model.id === parseRouted(id).model);
			if (base && !routed.some((model) => model.id === id)) routed.push({ ...base, id });
		}
		return routed.length ? [...models, ...routed] : models;
	}
	/** The model as the gateway names it, and the options that add the route to the request. */
	function unroute<M extends Model<Api>, O extends StreamOptions>(model: M, options: O | undefined): [M, O | undefined] {
		const { model: id, route } = parseRouted(model.id);
		if (!route) return [model, options];
		const onPayload = async (payload: unknown, sent: Model<Api>) => {
			const changed = await options?.onPayload?.(payload, sent);
			return addRoute((changed ?? payload) as Payload, route);
		};
		return [{ ...model, id }, { ...options, onPayload } as O];
	}
	return {
		...provider,
		getModels,
		stream: (model, context, options) => {
			const [sent, routed] = unroute(model, options);
			return provider.stream(sent, context, routed);
		},
		streamSimple: (model, context, options) => {
			const [sent, routed] = unroute(model, options);
			return provider.streamSimple(sent, context, routed);
		},
	} as Provider;
}

type VercelModel = Model<'anthropic-messages'>;

const VERCEL_BASE_URL = 'https://ai-gateway.vercel.sh';

function toVercelModel(info: ModelInfo, catalog: readonly VercelModel[]): VercelModel {
	const id = info.id.slice('vercel/'.length);
	const known = catalog.find((model) => model.id === id);
	const reasoning = info.reasoning.length > 0;
	if (known) return { ...known, cost: info.price, contextWindow: info.contextLength || known.contextWindow };
	// A model newer than pi's catalog borrows the wire quirks of its vendor's latest known model.
	const sibling = catalog.findLast((model) => model.id.startsWith(`${id.split('/')[0]}/`) && model.reasoning === reasoning);
	return {
		id,
		name: info.name,
		api: 'anthropic-messages',
		provider: 'vercel',
		baseUrl: VERCEL_BASE_URL,
		reasoning,
		// Mandatory reasoning has no "off"; send nothing rather than turn it off.
		...(reasoning && !info.reasoning.includes('off') ? { thinkingLevelMap: { ...sibling?.thinkingLevelMap, off: null } } : sibling?.thinkingLevelMap ? { thinkingLevelMap: sibling.thinkingLevelMap } : {}),
		input: info.vision ? ['text', 'image'] : ['text'],
		cost: info.price,
		contextWindow: info.contextLength,
		maxTokens: info.maxOutput ?? 32_768,
		...(sibling?.compat ? { compat: sibling.compat } : {}),
	};
}

/**
 * Vercel AI Gateway (vercel.com/docs/ai-gateway), as `vercel/<creator>/<model>`:
 * every model in its live list, over its Anthropic Messages endpoint as pi's
 * own `vercel-ai-gateway` provider calls it, with pi's tuned entries where it
 * knows the model. `key` is read on every call, so a key pasted in Settings ›
 * Subscriptions takes over from AI_GATEWAY_API_KEY at once.
 */
export function liveVercelProvider(live: () => readonly ModelInfo[], key: () => Promise<string | null>, routes: () => Iterable<string> = () => []): Provider {
	const catalog = (Object.values(VERCEL_AI_GATEWAY_MODELS) as VercelModel[]).map((model) => ({ ...model, provider: 'vercel' }));
	const base = createProvider<'anthropic-messages'>({
		id: 'vercel',
		name: 'Vercel AI Gateway',
		baseUrl: VERCEL_BASE_URL,
		auth: {
			apiKey: {
				name: 'Vercel AI Gateway API key',
				resolve: async () => {
					const apiKey = await key();
					return apiKey ? { auth: { apiKey }, source: 'Settings › Subscriptions' } : undefined;
				},
			},
		},
		models: [],
		api: anthropicMessagesApi(),
	});
	let memo: { from: readonly ModelInfo[]; models: VercelModel[] } | undefined;
	function getModels(): VercelModel[] {
		const current = live();
		if (memo?.from !== current) memo = { from: current, models: current.filter((info) => info.id.startsWith('vercel/')).map((info) => toVercelModel(info, catalog)) };
		return memo.models;
	}
	return withRoutes({ ...base, getModels } as Provider, routes, (payload, route) => {
		const options = (payload.providerOptions ?? {}) as Payload;
		return { ...payload, providerOptions: { ...options, gateway: { ...(options.gateway as object), ...vercelRouting(route) } } };
	});
}
