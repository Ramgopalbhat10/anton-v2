import type { ModelEndpoint, ModelInfo } from '../core/ports.ts';

/** After a refresh in the background fails, how long the last list is served before asking again. */
const RETRY_MS = 5 * 60_000;

export type CachedListOptions = { ttlMs: number; apiKey: () => string | null; fetchModels: (key: string | null) => Promise<ModelInfo[]> };

/**
 * A gateway's model list, cached for `ttlMs`. Once the time is up the last
 * list is still served at once while a new one is fetched behind it, so the
 * picker never waits on the gateway; a failed refresh keeps serving the last
 * good list, so a gateway hiccup never empties the picker; a new key lists
 * them again at once.
 */
export function cachedList({ ttlMs, apiKey, fetchModels }: CachedListOptions): (fresh?: boolean) => Promise<ModelInfo[]> {
	type Entry = { at: number; key: string | null; models: Promise<ModelInfo[]>; settled: boolean };
	let cached: Entry | undefined;
	let refreshing: Promise<unknown> | null = null;

	/** The last good list stays served until a newer one is in hand. */
	function refreshBehind(entry: Entry) {
		if (refreshing) return;
		refreshing = fetchModels(entry.key)
			.then(
				(models) => {
					if (cached === entry) cached = { at: Date.now(), key: entry.key, models: Promise.resolve(models), settled: true };
				},
				() => {
					if (cached === entry) entry.at = Date.now() - ttlMs + RETRY_MS;
				},
			)
			.finally(() => (refreshing = null));
	}

	return (fresh = false) => {
		const key = apiKey();
		const current = cached?.key === key ? cached : undefined;
		if (!fresh && current && Date.now() - current.at < ttlMs) return current.models;
		if (!fresh && current?.settled) {
			refreshBehind(current);
			return current.models;
		}
		const previous = cached?.models;
		const models = fetchModels(key).catch((error: unknown) => (previous ? previous : Promise.reject(error)));
		const entry: Entry = { at: Date.now(), key, models, settled: false };
		cached = entry;
		models.then(
			() => (entry.settled = true),
			// A failure with nothing to fall back on is retried on the next call.
			() => cached === entry && (cached = undefined),
		);
		return models;
	};
}

/** How long a model's providers are kept: their prices and speeds change slowly, and the menu should open at once. */
const ENDPOINTS_TTL_MS = 10 * 60_000;

/** A model's providers, each model's list kept for ten minutes; a failure is not kept, so the next look asks again. */
export function cachedEndpoints(fetchEndpoints: (model: string) => Promise<ModelEndpoint[]>): (model: string) => Promise<ModelEndpoint[]> {
	const kept = new Map<string, { at: number; endpoints: Promise<ModelEndpoint[]> }>();
	return (model) => {
		const hit = kept.get(model);
		if (hit && Date.now() - hit.at < ENDPOINTS_TTL_MS) return hit.endpoints;
		const endpoints = fetchEndpoints(model);
		kept.set(model, { at: Date.now(), endpoints });
		endpoints.catch(() => kept.get(model)?.endpoints === endpoints && kept.delete(model));
		return endpoints;
	};
}
