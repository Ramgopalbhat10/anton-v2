/**
 * Where a gateway sends a task's model calls. A gateway (OpenRouter, Vercel
 * AI Gateway) serves most models through several providers and picks one per
 * call; a task can ask it to try one provider first, or to rank them by price,
 * throughput or latency. Either way the gateway falls back to its own routing
 * when that provider fails or no provider fits, so a route never makes a call
 * fail that would have worked without it. A route is one or the other: a
 * provider, or a sort.
 */
export const ROUTE_SORTS = ['price', 'throughput', 'latency'] as const;
export type RouteSort = (typeof ROUTE_SORTS)[number];

export type ModelRoute = { provider: string; sort?: undefined } | { sort: RouteSort; provider?: undefined };

/** The gateways whose calls take a route, by the `<gateway>` a model id starts with. */
export const ROUTED_GATEWAYS = ['openrouter', 'vercel'] as const;

/** Whether a model (`<gateway>/<model>`) is on a gateway that takes a route. */
export const routable = (model: string): boolean => ROUTED_GATEWAYS.some((gateway) => model.startsWith(`${gateway}/`));

/**
 * The route as part of the model specifier the agents resolve, `<model>#via=<provider>` or
 * `<model>#sort=<sort>`, so each task's calls carry their own route through the runtime.
 * No gateway's model id has a `#`.
 */
export function routedId(model: string, route: ModelRoute | null): string {
	if (!route || !routable(model)) return model;
	return route.provider ? `${model}#via=${route.provider}` : `${model}#sort=${route.sort}`;
}

/** The model a routed specifier names, and its route; a plain one has none. */
export function parseRouted(id: string): { model: string; route: ModelRoute | null } {
	const at = id.indexOf('#');
	if (at < 0) return { model: id, route: null };
	const model = id.slice(0, at);
	const [key, value = ''] = id.slice(at + 1).split('=');
	if (key === 'via' && value) return { model, route: { provider: value } };
	if (key === 'sort' && (ROUTE_SORTS as readonly string[]).includes(value)) return { model, route: { sort: value as RouteSort } };
	return { model, route: null };
}

/** The model a specifier names, without its route, as usage and the model list name it. */
export const unrouted = (id: string): string => parseRouted(id).model;

/** A stored route, checked: anything else reads as none. */
export function asRoute(value: unknown): ModelRoute | null {
	if (!value || typeof value !== 'object') return null;
	const { provider, sort } = value as { provider?: unknown; sort?: unknown };
	if (typeof provider === 'string' && /^[\w.\-/:]{1,80}$/.test(provider)) return { provider };
	if (typeof sort === 'string' && (ROUTE_SORTS as readonly string[]).includes(sort)) return { sort: sort as RouteSort };
	return null;
}

/**
 * OpenRouter's `provider` preferences (openrouter.ai/docs/features/provider-routing): the provider
 * first with the rest after it (`allow_fallbacks`), or every provider ranked by the sort.
 */
export function openRouterRouting(route: ModelRoute): Record<string, unknown> {
	return route.provider ? { order: [route.provider], allow_fallbacks: true } : { sort: route.sort, allow_fallbacks: true };
}

const VERCEL_SORTS: Record<RouteSort, string> = { price: 'cost', throughput: 'tps', latency: 'ttft' };

/**
 * Vercel AI Gateway's `providerOptions.gateway` (vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering):
 * `order` tries the provider first and the others after it; `sort` ranks them all.
 */
export function vercelRouting(route: ModelRoute): Record<string, unknown> {
	return route.provider ? { order: [route.provider] } : { sort: VERCEL_SORTS[route.sort!] };
}
