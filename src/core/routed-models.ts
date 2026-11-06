import { parseRouted, validModelSpecifier } from './model-route.ts';

// This is a resolution catalog, not a selected/default route. Each call still names its full
// specifier, so registering a helper or coordinator cannot affect another context's calls.
const scopes = new Map<string, string[]>();

export function registerRoutedModels(scope: string, models: Iterable<string | null | undefined>): void {
	const routed = [...new Set(models)].filter((model): model is string => Boolean(model && validModelSpecifier(model) && parseRouted(model).route));
	if (routed.length) scopes.set(scope, routed);
	else scopes.delete(scope);
}

export const registeredRoutedModels = (): string[] => [...new Set([...scopes.values()].flat())];
