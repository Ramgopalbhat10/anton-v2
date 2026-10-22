import { createHash } from 'node:crypto';
import { announce } from '../core/changes.ts';
import { routable } from '../core/model-route.ts';
import type { ModelCatalog, ModelEndpoint, ModelInfo, Reasoning } from '../core/ports.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { openRouterKey } from '../providers/openrouter/key.ts';
import { logProblem } from './log.ts';
import { gatewayOffered, subscriptionModels } from './subscriptions.ts';

let loaded: readonly ModelInfo[] = [];

/** A gateway's list as last fetched, kept so the first list after a restart does not wait on the gateway. */
const SAVED_GATEWAY = 'gateway-models';
type SavedGateway = { key: string; models: ModelInfo[] };

/** Names the key a saved list was made with, without keeping the key. */
const keyName = (key: string | null) => createHash('sha256').update(key ?? '').digest('hex').slice(0, 16);

/** What one gateway's listing has done in this process: the catalog's list it last saved, and whether it has listed. */
type Listing = { kept: Promise<ModelInfo[]> | null; listedHere: boolean };
const listings = new Map<string, Listing>();

/**
 * One gateway's models. The catalog keeps its list for an hour and refreshes it
 * behind the one it serves; right after a start, the list saved last time is
 * served while the catalog fetches, and open pages hear when the new one lands.
 */
async function listed(id: string, catalog: ModelCatalog, apiKey: () => string | null): Promise<ModelInfo[]> {
	if (!(await gatewayOffered(id))) return [];
	// OpenRouter's list kept the setting's first name.
	const setting = id === 'openrouter' ? SAVED_GATEWAY : `${SAVED_GATEWAY}.${id}`;
	// Read once offered, as that loads the pasted key.
	const key = keyName(apiKey());
	const state = listings.get(id) ?? { kept: null, listedHere: false };
	listings.set(id, state);
	const listing = catalog.list();
	if (listing !== state.kept) {
		state.kept = listing;
		listing.then(async (models) => {
			const first = !state.listedHere;
			state.listedHere = true;
			await setSetting(setting, { key, models } satisfies SavedGateway).catch((error: unknown) => logProblem('warn', 'Could not keep the model list', error));
			if (first) announce({ kind: 'models' });
		}, () => undefined);
	}
	if (state.listedHere) return listing;
	const saved = await getSetting<SavedGateway | null>(setting, null).catch(() => null);
	return saved?.key === key && saved.models.length ? saved.models : listing;
}

/** OpenRouter's models, through the `models` catalog. */
const gatewayModels = (): Promise<ModelInfo[]> => listed('openrouter', getProviders().models, openRouterKey);

/** The other gateways' models (Vercel AI Gateway), each while it has a key and is switched on; one failing leaves the rest. */
async function otherGatewayModels(): Promise<ModelInfo[]> {
	const lists = await Promise.all(
		(getProviders().gateways ?? []).map((gateway) =>
			listed(gateway.account.id, gateway.models, gateway.key.get).catch((error: unknown) => {
				logProblem('warn', `Could not load ${gateway.account.name} models`, error);
				return [];
			}),
		),
	);
	return lists.flat();
}

/**
 * Every model offered for agent work: the gateways' while each has a key and
 * is switched on, then those of the plans you signed in to. Any one failing
 * leaves the others; all failing is an error. Each source answers from the
 * list it has while it lists again behind it, so this rarely waits.
 */
export async function listModels(): Promise<ModelInfo[]> {
	const [gateway, others, plans] = await Promise.allSettled([gatewayModels(), otherGatewayModels(), subscriptionModels()]);
	const more = others.status === 'fulfilled' ? others.value : [];
	if (gateway.status === 'rejected' && (plans.status === 'rejected' || plans.value.length === 0) && more.length === 0) throw gateway.reason;
	const models = [...(gateway.status === 'fulfilled' ? gateway.value : []), ...more, ...(plans.status === 'fulfilled' ? plans.value : [])];
	if (plans.status === 'rejected') logProblem('warn', 'Could not load subscription models', plans.reason);
	loaded = models;
	return models;
}

/** The providers a gateway can send a model's calls to, for a task's route; empty for a model on a plan. */
export async function modelEndpoints(model: string): Promise<ModelEndpoint[]> {
	const gateway = model.split('/')[0];
	const catalog = gateway === 'openrouter' ? getProviders().models : getProviders().gateways?.find((entry) => entry.account.gateway === gateway)?.models;
	if (!catalog?.endpoints || !routable(model)) return [];
	return catalog.endpoints(model);
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
