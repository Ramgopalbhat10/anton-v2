import { createHash } from 'node:crypto';
import { announce } from '../../core/changes.ts';
import { routable, unrouted, validModelSpecifier } from '../../core/model-route.ts';
import type { ModelCatalog, ModelEndpoint, ModelInfo, Reasoning } from '../../core/ports.ts';
import { getSetting, setSetting } from '../../db/settings.ts';
import { getProviders } from '../../providers/index.ts';
import { openRouterKey } from '../../providers/openrouter/key.ts';
import { logProblem } from '../../core/log.ts';
import { gatewayOffered, subscriptionModels } from './subscriptions.ts';

let loaded: readonly ModelInfo[] = [];

/** Kept so the first list after a restart does not wait on the gateway. */
const SAVED_GATEWAY = 'gateway-models';
type SavedGateway = { key: string; models: ModelInfo[] };

/** Names the key a saved list was made with, without keeping the key. */
const keyName = (key: string | null) => createHash('sha256').update(key ?? '').digest('hex').slice(0, 16);

type Listing = { kept: Promise<ModelInfo[]> | null; listedHere: boolean };
const listings = new Map<string, Listing>();

/** The catalog keeps its list for an hour; right after a start the saved list is served while it fetches, and open pages hear when the new one lands. */
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

const gatewayModels = (): Promise<ModelInfo[]> => listed('openrouter', getProviders().models, openRouterKey);

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

/** Any source failing leaves the others; all failing is an error. Each answers from the list it has while it lists again, so this rarely waits. */
export async function listModels(): Promise<ModelInfo[]> {
	const [gateway, others, plans] = await Promise.allSettled([gatewayModels(), otherGatewayModels(), subscriptionModels()]);
	const more = others.status === 'fulfilled' ? others.value : [];
	if (gateway.status === 'rejected' && (plans.status === 'rejected' || plans.value.length === 0) && more.length === 0) throw gateway.reason;
	const models = [...(gateway.status === 'fulfilled' ? gateway.value : []), ...more, ...(plans.status === 'fulfilled' ? plans.value : [])];
	if (plans.status === 'rejected') logProblem('warn', 'Could not load subscription models', plans.reason);
	loaded = models;
	return models;
}

export async function modelEndpoints(model: string): Promise<ModelEndpoint[]> {
	const gateway = model.split('/')[0];
	const catalog = gateway === 'openrouter' ? getProviders().models : getProviders().gateways?.find((entry) => entry.account.gateway === gateway)?.models;
	if (!catalog?.endpoints || !routable(model)) return [];
	return catalog.endpoints(model);
}

export function loadedModels(): readonly ModelInfo[] {
	return loaded;
}

export async function findModel(id: string): Promise<ModelInfo | undefined> {
	if (!validModelSpecifier(id)) return undefined;
	return (await listModels()).find((model) => model.id === unrouted(id));
}

export function reasoningFor(model: ModelInfo | undefined, chosen: Reasoning | null): Reasoning {
	if (!model?.reasoning.length) return 'off';
	return chosen && model.reasoning.includes(chosen) ? chosen : model.defaultReasoning;
}

const PINNED = 'pinned-models';

export function pinnedModels(): Promise<string[]> {
	return getSetting<string[]>(PINNED, []);
}

/** One that is no longer listed is kept, so it comes back when its model does. */
export async function setPinnedModels(ids: string[]): Promise<string[]> {
	const pinned = [...new Set(ids)];
	await setSetting(PINNED, pinned);
	announce({ kind: 'models' });
	return pinned;
}
