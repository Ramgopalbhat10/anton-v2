import type { SandboxResources } from '../core/ports.ts';
import { config } from '../config.ts';
import { retireDefaultWarmImages } from '../db/projects.ts';
import { getSetting, setSetting } from '../db/settings.ts';

/** Regions a sandbox can be pinned to; Modal charges more for a pinned one. */
export const REGIONS = ['us', 'eu', 'ap'] as const;
export type Region = (typeof REGIONS)[number];

/** What every new sandbox gets, unless its repository sets its own base image. */
export type SandboxSettings = {
	cpu: number;
	memoryMiB: number;
	idleMinutes: number;
	lifetimeHours: number;
	/** Null lets the provider choose. */
	region: Region | null;
	/** Domains sandboxes may reach; empty allows all. */
	allowedDomains: string[];
	/** Null uses ANTON_BASE_IMAGE. */
	baseImage: string | null;
	/** Prepared repo images older than this are rebuilt on the next task. */
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

/** Saved settings over the defaults, so a field added later has a value. */
export async function sandboxSettings(): Promise<SandboxSettings> {
	return { ...defaultSandboxSettings(), ...(await getSetting<Partial<SandboxSettings>>(KEY, {})) };
}

/** Saves them; a new default base image retires the prepared images built from the old one. */
export async function setSandboxSettings(next: SandboxSettings): Promise<SandboxSettings> {
	const before = await sandboxSettings();
	await setSetting(KEY, next);
	if (before.baseImage !== next.baseImage) await retireDefaultWarmImages();
	return next;
}

/** Setup clones and fetches from GitHub inside the sandbox, so an allowlist always keeps it reachable. */
const GIT_HOST_DOMAINS = ['github.com', '*.github.com', '*.githubusercontent.com'];

export function resourcesFrom(settings: SandboxSettings): SandboxResources {
	return {
		cpu: settings.cpu,
		memoryMiB: settings.memoryMiB,
		idleTimeoutMs: settings.idleMinutes * 60_000,
		lifetimeMs: settings.lifetimeHours * 3_600_000,
		regions: settings.region ? [settings.region] : [],
		allowedDomains: settings.allowedDomains.length ? [...new Set([...settings.allowedDomains, ...GIT_HOST_DOMAINS])] : [],
	};
}
