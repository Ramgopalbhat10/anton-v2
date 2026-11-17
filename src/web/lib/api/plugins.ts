import { json, post, request } from './http';

export type Command = { name: string; prompt: string };

/** A null ref is the repository's default branch. */
export type PluginSource = { repo: string; path: string; ref: string | null };

export type Plugin = {
	id: string;
	name: string;
	description: string;
	source: PluginSource;
	sha: string;
	marketplace: string | null;
	/** A skill is inactive when its plugin is off, or an earlier plugin has a skill by that name. */
	skills: Array<{ name: string; description: string; active: boolean }>;
	/** MCP servers the plugin declares; Anton does not run them. */
	mcpServers: string[];
	skipped: string[];
	enabled: boolean;
	installedAt: string;
	/** Where it was installed from, so it can be installed again to update it. */
	pick: PluginPick | null;
};

export type PluginPick = { marketplace: string; name: string } | { address: string } | { plugin: string };

export type PluginPreview = {
	id: string;
	name: string;
	description: string;
	source: PluginSource;
	sha: string;
	marketplace: string | null;
	pick: PluginPick;
	skills: Array<{ name: string; description: string; folder: string; license: string | null }>;
	mcpServers: string[];
	skipped: string[];
	files: string[];
	truncated: boolean;
	readme: string | null;
	installed: { sha: string; enabled: boolean } | null;
	/** A newer commit of an installed plugin. */
	update: string | null;
	/** For a skill installed from a file on the Artifacts page, that file's path there. */
	added?: string;
};

export type GitHubSkill = { address: string; repo: string; name: string; description: string };
export type GitHubRepo = { address: string; description: string; stars: number };
export type GitHubSearch = { skills: GitHubSkill[]; repos: GitHubRepo[]; problems: string[] };

export type CatalogItem = { id: string; name: string; description: string; source: PluginSource; skills: string[] | null; bundle?: string; browseable?: boolean; installed: boolean };

export type SkillSummary = { name: string; description: string };

export const pluginsApi = {
	plugins: () => json<{ plugins: Plugin[]; marketplaces: string[] }>('/api/plugins'),
	saveMarketplaces: (marketplaces: string[]) =>
		json<{ marketplaces: string[] }>('/api/settings/marketplaces', { method: 'PUT', body: JSON.stringify({ marketplaces }) }),
	catalog: (repo: string, bundle?: string) => json<{ entries: CatalogItem[] }>(`/api/marketplaces/catalog?repo=${encodeURIComponent(repo)}${bundle ? `&bundle=${encodeURIComponent(bundle)}` : ''}`),
	installPlugin: (input: PluginPick) => post<{ plugins: Plugin[] }>('/api/plugins', input),
	previewPlugin: (pick: PluginPick) => json<PluginPreview>(`/api/plugins/preview?${new URLSearchParams(pick)}`),
	pluginFile: async (repo: string, sha: string, path: string) =>
		new Uint8Array(await (await request(`/api/plugins/file?${new URLSearchParams({ repo, sha, path })}`)).arrayBuffer()),
	searchGitHub: (q: string, signal?: AbortSignal) => json<GitHubSearch>(`/api/skills/search?q=${encodeURIComponent(q)}`, { signal }),
	setPluginEnabled: (id: string, enabled: boolean) =>
		json<{ plugins: Plugin[] }>(`/api/plugins/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
	removePlugin: (id: string) => json<{ plugins: Plugin[] }>(`/api/plugins/${id}`, { method: 'DELETE' }),
	sessionSkills: (id: string) => json<{ skills: SkillSummary[] }>(`/api/sessions/${id}/skills`),
	commands: () => json<{ commands: Command[] }>('/api/settings/commands'),
	saveCommands: (commands: Command[]) =>
		json<{ commands: Command[] }>('/api/settings/commands', { method: 'PUT', body: JSON.stringify({ commands }) }),
	/** Installs a file you added as a skill: its front matter names it, whatever the file is called. */
	installAddedSkill: (path: string) => post<{ plugins: Plugin[] }>('/api/artifacts/skill', { path }),
};
