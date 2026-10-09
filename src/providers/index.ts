import path from 'node:path';
import { config } from '../config.ts';
import type { DecisionModel, GitHost, ModelCatalog, ObjectStore, SandboxProvider, SubscriptionProvider } from '../core/ports.ts';
import { chatGptSubscription } from './chatgpt/subscription.ts';
import { diskStore } from './disk/store.ts';
import { githubHost } from './github/host.ts';
import { localSandboxProvider } from './local/sandbox.ts';
import { modalSandboxProvider } from './modal/sandbox.ts';
import { openRouterCatalog } from './openrouter/catalog.ts';
import { openRouterDecisions } from './openrouter/decisions.ts';
import { s3Store } from './s3/store.ts';

/** Add a provider by adding one entry; choose it with ANTON_SANDBOX / ANTON_STORE. */
const sandboxes: Record<string, () => SandboxProvider> = {
	modal: () => modalSandboxProvider({ ...config.modal, browserPackage: config.browserPackage }),
	local: () => localSandboxProvider(config.dataDir),
};

const stores: Record<string, () => ObjectStore> = {
	s3: () => s3Store(config.s3),
	disk: () => diskStore(path.join(config.dataDir, 'objects')),
};

function pick<T>(kind: string, table: Record<string, () => T>, name: string): T {
	const make = table[name];
	if (!make) throw new Error(`Unknown ${kind} provider "${name}". Options: ${Object.keys(table).join(', ')}`);
	return make();
}

/**
 * `decisions` is null without an OpenRouter key or with ANTON_DECISION_MODEL=off; everything works without it, as it did before.
 * `subscriptions` are the plans you can sign in to in Settings › Subscriptions; add one by adding an entry.
 */
export type Providers = {
	sandbox: SandboxProvider;
	store: ObjectStore;
	git: GitHost;
	models: ModelCatalog;
	decisions?: DecisionModel | null;
	subscriptions?: SubscriptionProvider[];
};

function decisionModel(): DecisionModel | null {
	const { apiUrl, apiKey } = config.openrouter;
	return apiKey && config.decisionModel !== 'off' ? openRouterDecisions({ apiUrl, apiKey, model: config.decisionModel }) : null;
}

let providers: Providers | undefined;

export function getProviders(): Providers {
	providers ??= {
		sandbox: pick('sandbox', sandboxes, config.sandbox),
		store: pick('store', stores, config.store),
		git: githubHost(config.github),
		models: openRouterCatalog(config.openrouter),
		decisions: decisionModel(),
		subscriptions: [chatGptSubscription()],
	};
	return providers;
}

/** Tests swap in fakes here. */
export function setProviders(next: Providers): void {
	providers = next;
}
