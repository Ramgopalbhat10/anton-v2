import { createHash } from 'node:crypto';
import { announce } from '../core/changes.ts';
import type { ModelInfo, Reasoning } from '../core/ports.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { openRouterKey } from '../providers/openrouter/key.ts';
import { logProblem } from './log.ts';
import { gatewayOffered, subscriptionModels } from './subscriptions.ts';

let loaded: readonly ModelInfo[] = [];

/** The gateway's list as last fetched, kept so the first list after a restart does not wait on OpenRouter. */
const SAVED_GATEWAY = 'gateway-models';
type SavedGateway = { key: string; models: ModelInfo[] };

/** Names the key a saved list was made with, without keeping the key. */
const keyName = () => createHash('sha256').update(openRouterKey() ?? '').digest('hex').slice(0, 16);

/** The catalog's list this process last saved, and whether the catalog has listed in this process. */
let kept: Promise<ModelInfo[]> | null = null;
let listedHere = false;

/**
 * The gateway's models. The catalog keeps its list for an hour and refreshes it
 * behind the one it serves; right after a start, the list saved last time is
 * served while the catalog fetches, and open pages hear when the new one lands.
 */
async function gatewayModels(): Promise<ModelInfo[]> {
	if (!(await gatewayOffered())) return [];
	const key = keyName();
	const listing = getProviders().models.list();
	if (listing !== kept) {
		kept = listing;
		listing.then(async (models) => {
			const first = !listedHere;
			listedHere = true;
			await setSetting(SAVED_GATEWAY, { key, models } satisfies SavedGateway).catch((error: unknown) => logProblem('warn', 'Could not keep the model list', error));
			if (first) announce({ kind: 'models' });
		}, () => undefined);
	}
	if (listedHere) return listing;
	const saved = await getSetting<SavedGateway | null>(SAVED_GATEWAY, null).catch(() => null);
	return saved?.key === key && saved.models.length ? saved.models : listing;
}

/**
 * Every model offered for agent work: the gateway's while it has a key and is
 * switched on, then those of the plans you signed in to. Either one failing
 * leaves the other; both failing is an error. Each source answers from the
 * list it has while it lists again behind it, so this rarely waits.
 */
export async function listModels(): Promise<ModelInfo[]> {
	const [gateway, plans] = await Promise.allSettled([gatewayModels(), subscriptionModels()]);
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
