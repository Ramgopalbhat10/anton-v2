import type { SandboxResources, SandboxRuntime } from '../../core/ports.ts';
import { config } from '../../config.ts';
import { retireDefaultWarmImages } from '../../db/projects.ts';
import { getSetting, setSetting } from '../../db/settings.ts';

/** Modal charges more for a pinned sandbox. */
export const REGIONS = ['us', 'eu', 'ap'] as const;
export type Region = (typeof REGIONS)[number];

export type SandboxSettings = {
	cpu: number;
	memoryMiB: number;
	idleMinutes: number;
	lifetimeHours: number;
	region: Region | null;
	allowedDomains: string[];
	baseImage: string | null;
	warmImageDays: number;
};

const KEY = 'sandbox';

export const defaultSandboxSettings = (): SandboxSettings => ({
	...config.sandboxDefaults,
	lifetimeHours: 24,
	region: null,
	allowedDomains: [],
	baseImage: null,
	warmImageDays: config.warmImageDays,
});

/** Over the defaults, so a field added later has a value. */
export async function sandboxSettings(): Promise<SandboxSettings> {
	return { ...defaultSandboxSettings(), ...(await getSetting<Partial<SandboxSettings>>(KEY, {})) };
}

/** A new default base image retires the prepared images built from the old one. */
export async function setSandboxSettings(next: SandboxSettings): Promise<SandboxSettings> {
	const before = await sandboxSettings();
	await setSetting(KEY, next);
	if (before.baseImage !== next.baseImage) await retireDefaultWarmImages();
	return next;
}

/** Setup clones and fetches from GitHub inside the sandbox, so an allowlist always keeps it reachable. */
const GIT_HOST_DOMAINS = ['github.com', '*.github.com', '*.githubusercontent.com'];

/** A repository can ask for a full VM; everything else runs in a container. */
export function resourcesFrom(settings: SandboxSettings, runtime: SandboxRuntime = 'container'): SandboxResources {
	return {
		runtime,
		cpu: settings.cpu,
		memoryMiB: settings.memoryMiB,
		idleTimeoutMs: settings.idleMinutes * 60_000,
		lifetimeMs: settings.lifetimeHours * 3_600_000,
		regions: settings.region ? [settings.region] : [],
		allowedDomains: settings.allowedDomains.length ? [...new Set([...settings.allowedDomains, ...GIT_HOST_DOMAINS])] : [],
	};
}
