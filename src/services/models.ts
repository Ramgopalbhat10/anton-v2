import { announce } from '../core/changes.ts';
import type { ModelInfo, Reasoning } from '../core/ports.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { logProblem } from './log.ts';
import { subscriptionModels } from './subscriptions.ts';

let loaded: readonly ModelInfo[] = [];

/**
 * Every model offered for agent work: the gateway's, then those of the plans
 * you signed in to. Either one failing leaves the other; both failing is an error.
 */
export async function listModels(): Promise<ModelInfo[]> {
	const [gateway, plans] = await Promise.allSettled([getProviders().models.list(), subscriptionModels()]);
	if (gateway.status === 'rejected' && (plans.status === 'rejected' || plans.value.length === 0)) throw gateway.reason;
	const models = [...(gateway.status === 'fulfilled' ? gateway.value : []), ...(plans.status === 'fulfilled' ? plans.value : [])];
	if (plans.status === 'rejected') logProblem('warn', 'Could not load subscription models', plans.reason);
	loaded = models;
	return models;
}

/** The last list fetched, for the agent's synchronous model lookup. */
export function loadedModels(): readonly ModelInfo[] {
	return loaded;
}

export async function findModel(id: string): Promise<ModelInfo | undefined> {
	return (await listModels()).find((model) => model.id === id);
}

/** The level a task runs at: its own choice when the model accepts it, else the model's default. */
export function reasoningFor(model: ModelInfo | undefined, chosen: Reasoning | null): Reasoning {
	if (!model?.reasoning.length) return 'off';
	return chosen && model.reasoning.includes(chosen) ? chosen : model.defaultReasoning;
}

const PINNED = 'pinned-models';

/** Models you pinned to the top of the model picker, in the order you pinned them. */
export function pinnedModels(): Promise<string[]> {
	return getSetting<string[]>(PINNED, []);
}

/** Saves the pins, each once, in order; one that is no longer listed is kept, so it comes back when its model does. */
export async function setPinnedModels(ids: string[]): Promise<string[]> {
	const pinned = [...new Set(ids)];
	await setSetting(PINNED, pinned);
	announce({ kind: 'models' });
	return pinned;
}
