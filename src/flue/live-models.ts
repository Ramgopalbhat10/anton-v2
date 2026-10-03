import type { Model, Provider } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
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
 * wire settings. `live` is read on every lookup, so newly listed models
 * resolve without a restart.
 */
export function liveOpenRouterProvider(live: () => readonly ModelInfo[]): Provider {
	const base = openrouterProvider() as Provider<'openai-completions'>;
	const known = base.getModels();
	const knownIds = new Set(known.map((model) => model.id));
	let memo: { from: readonly ModelInfo[]; models: OpenRouterModel[] } | undefined;
	function getModels(): OpenRouterModel[] {
		const current = live();
		if (memo?.from !== current) {
			const added = current.filter((info) => !knownIds.has(info.id.slice('openrouter/'.length)));
			memo = { from: current, models: [...known, ...added.map((info) => toPiModel(info, known))] };
		}
		return memo.models;
	}
	return { ...base, getModels } as Provider;
}
