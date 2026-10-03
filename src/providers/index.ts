import path from 'node:path';
import { config } from '../config.ts';
import type { GitHost, ModelCatalog, ObjectStore, SandboxProvider } from '../core/ports.ts';
import { diskStore } from './disk/store.ts';
import { githubHost } from './github/host.ts';
import { localSandboxProvider } from './local/sandbox.ts';
import { modalSandboxProvider } from './modal/sandbox.ts';
import { openRouterCatalog } from './openrouter/catalog.ts';
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

export type Providers = { sandbox: SandboxProvider; store: ObjectStore; git: GitHost; models: ModelCatalog };

let providers: Providers | undefined;

export function getProviders(): Providers {
	providers ??= {
		sandbox: pick('sandbox', sandboxes, config.sandbox),
		store: pick('store', stores, config.store),
		git: githubHost(config.github),
		models: openRouterCatalog(config.openrouter),
	};
	return providers;
}

/** Tests swap in fakes here. */
export function setProviders(next: Providers): void {
	providers = next;
}
