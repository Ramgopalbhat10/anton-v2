import type { SkillsTab, ViewSearch } from './skills';

/*
 * What each settings page keeps in its address. The app's router and the
 * Settings card's own router (modal.tsx) both read addresses with these.
 */

/** The Skills page keeps its tab and search here, so coming back from a plugin finds them again; Connectors hears here how a Google sign-in went. */
export const sectionSearch = (search: Record<string, unknown>): { tab?: SkillsTab; q?: string; connected?: string; problem?: string } => ({
	tab: search.tab === 'installed' || search.tab === 'discover' ? search.tab : undefined,
	q: typeof search.q === 'string' && search.q ? search.q : undefined,
	connected: typeof search.connected === 'string' && search.connected ? search.connected : undefined,
	problem: typeof search.problem === 'string' && search.problem ? search.problem.slice(0, 500) : undefined,
});

export const skillViewSearch = (search: Record<string, unknown>): ViewSearch =>
	Object.fromEntries(['marketplace', 'name', 'address', 'plugin'].flatMap((key) => (typeof search[key] === 'string' ? [[key, search[key]]] : [])));

/** `c` is a connector you have (`mail:gmail`, `mcp:<name>`), `add` one from the catalog; a sign-in comes back with how it went. */
export const connectorViewSearch = (search: Record<string, unknown>): { c?: string; add?: string; connected?: string; problem?: string } =>
	Object.fromEntries(['c', 'add', 'connected', 'problem'].flatMap((key) => (typeof search[key] === 'string' && search[key] ? [[key, (search[key] as string).slice(0, 500)]] : [])));
