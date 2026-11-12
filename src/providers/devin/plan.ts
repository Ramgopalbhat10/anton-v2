import type { KeyPlan, SubscriptionModel } from '../../core/ports.ts';
import { discoverDevinModels, type DevinModel } from './worker.ts';

export function toDevinModel(model: DevinModel): SubscriptionModel {
	return {
		id: `devin/${model.id}`, name: model.name, vendor: 'Cognition',
		...(model.requestModelId ? { requestModelId: model.requestModelId } : {}),
		description: 'Experimental Devin provider through a server-side oh-my-pi Bun worker. Anton runs the tools.',
		createdAt: 0, contextLength: model.contextWindow, maxOutput: model.maxTokens,
		vision: model.input.includes('image'), reasoning: [], defaultReasoning: 'off', listPrice: model.cost,
	};
}

/** Cached by the subscriptions service; model calls never perform discovery. */
export function devinPlan(discover: typeof discoverDevinModels = discoverDevinModels): KeyPlan {
	let checked: { key: string; models: DevinModel[] } | undefined;
	return {
		id: 'devin', name: 'Devin', gateway: 'devin', keyPage: 'https://app.devin.ai/settings/devin-api?tab=pats',
		check: async (key) => { checked = { key, models: await discover(key) }; return { email: null }; },
		listModels: async (key) => {
			const models = checked?.key === key ? checked.models : await discover(key);
			checked = undefined;
			return ['swe-2-flash', 'swe-2'].flatMap((id) => models.filter((model) => model.id === id).map(toDevinModel));
		},
	};
}
