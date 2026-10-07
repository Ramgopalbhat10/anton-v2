import { createHash } from 'node:crypto';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import {
	type CatalogEntry,
	type ParsedSkill,
	type PluginSource,
	parseFrontMatter,
	parseGitHub,
	type PluginPick,
	readCatalog,
	readCatalogBundle,
	readPlugin,
	readRepoSkills,
	type RepoFiles,
} from '../core/plugins.ts';
import { deletePlugin, getPlugin, type InstalledPlugin, listPlugins, savePlugin, setPluginEnabled } from '../db/plugins.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import type { FileHit } from '../core/ports.ts';
import { getProviders } from '../providers/index.ts';
import { logProblem } from './log.ts';
import { snapshotFiles } from './repo-snapshot.ts';

/** Marketplaces offered until the user picks their own: Anthropic's skills, and Devin's catalog of plugins from many vendors. */
const DEFAULT_MARKETPLACES = ['anthropics/skills', 'CognitionAI/devin-marketplace'];
/** A catalog is read again after this long, so new plugins show up. */
const CATALOG_TTL_MS = 10 * 60_000;
/** The repo's own instructions shown to a read-only task; a sandbox's agent reads them from its files. */
const MAX_INSTRUCTIONS = 20_000;

export const marketplaces = () => getSetting<string[]>('marketplaces', DEFAULT_MARKETPLACES);

/** Saves the marketplaces as `owner/repo` or `owner/repo/folder`. */
export async function setMarketplaces(list: string[]): Promise<string[]> {
	const saved: string[] = [];
	for (const item of list) {
		const found = parseGitHub(item);
		if (!found) throw new InvalidInputError(`"${item}" is not a GitHub repository`);
		const name = [found.repo, found.path].filter(Boolean).join('/');
		if (!saved.some((existing) => existing.toLowerCase() === name.toLowerCase())) saved.push(name);
	}
	await setSetting('marketplaces', saved);
	return saved;
}

/** A repo's files at a branch or commit, and the commit. */
async function filesAt(repo: string, ref: string | null): Promise<{ files: RepoFiles; sha: string }> {
	const git = getProviders().git;
	const sha = await git.resolveRef(repo, ref ?? (await git.getRepo(repo)).defaultBranch);
	return { files: await snapshotFiles(repo, sha), sha };
}

/** Installing the same plugin again updates it in place. */
const idFor = (source: PluginSource, skills: string[] | null) =>
	`plugin_${createHash('sha256')
		.update(JSON.stringify([source.repo.toLowerCase(), source.path, skills ?? []]))
		.digest('hex')
		.slice(0, 16)}`;

export type CatalogItem = CatalogEntry & { id: string; installed: boolean };
const catalogs = new Map<string, { at: number; entries: CatalogEntry[]; expanded: Set<string> }>();

/** What one marketplace offers, and which of it is installed. */
export async function catalog(marketplace: string, bundle?: string): Promise<CatalogItem[]> {
	const found = parseGitHub(marketplace);
	if (!found) throw new InvalidInputError(`"${marketplace}" is not a GitHub repository`);
	const key = marketplace.toLowerCase();
	let cached = catalogs.get(key);
	if (!cached || Date.now() - cached.at > CATALOG_TTL_MS) {
		const { files, sha } = await filesAt(found.repo, found.ref);
		cached = { at: Date.now(), entries: await readCatalog(files, { ...found, ref: sha }), expanded: new Set() };
		catalogs.set(key, cached);
	}
	if (bundle && !cached.expanded.has(bundle)) {
		const entry = cached.entries.find((item) => !item.bundle && item.name === bundle);
		if (!entry) throw new NotFoundError(`${marketplace} does not list ${bundle}`);
		if (entry.browseable) {
			const { files, sha } = await filesAt(entry.source.repo, entry.source.ref);
			const children = await readCatalogBundle(files, { ...entry, source: { ...entry.source, ref: sha } });
			// Replace rather than append, so concurrent requests cannot duplicate rows.
			cached.entries = [...cached.entries.filter((item) => item.bundle !== bundle), ...children];
		}
		cached.expanded.add(bundle);
	}
	const installed = new Set((await listPlugins()).map((plugin) => plugin.id));
	return cached.entries
		.filter((entry) => !bundle || entry.bundle === bundle)
		.map((entry) => {
			const id = idFor({ ...entry.source, ref: null }, entry.skills);
			return { ...entry, id, installed: installed.has(id) };
		});
}

type Resolved = { source: PluginSource; named: string[] | null; fallback: string; marketplace: string | null };

/** Where a pick lives, and which of its skills a marketplace names. */
async function resolve(pick: PluginPick): Promise<Resolved> {
	if ('address' in pick) {
		const found = parseGitHub(pick.address);
		if (!found) throw new InvalidInputError('Give a GitHub repository, such as owner/repo or owner/repo/skills/name, or its URL');
		return { source: found, named: null, fallback: '', marketplace: null };
	}
	const entries = await catalog(pick.marketplace);
	let entry = entries.find((item) => item.name === pick.name);
	// Re-resolve a lazily browsed skill after cache expiry or a server restart.
	if (!entry) {
		const parent = entries.filter((item) => item.browseable && pick.name.startsWith(`${item.name}/`)).sort((a, b) => b.name.length - a.name.length)[0];
		if (parent) entry = (await catalog(pick.marketplace, parent.name)).find((item) => item.name === pick.name);
	}
	if (!entry) throw new NotFoundError(`${pick.marketplace} does not list ${pick.name}`);
	return { source: entry.source, named: entry.skills, fallback: entry.name, marketplace: pick.marketplace };
}

/** A plugin installed before its pick was kept came from its address. */
const pickOf = (plugin: InstalledPlugin): PluginPick => plugin.pick ?? { address: [plugin.source.repo, plugin.source.path].filter(Boolean).join('/') };

/** An installed plugin, or not found. */
async function installed(id: string): Promise<InstalledPlugin> {
	const plugin = await getPlugin(id);
	if (!plugin) throw new NotFoundError('Plugin not found');
	return plugin;
}

/**
 * Installs a plugin from a marketplace by name, or from a GitHub address: a
 * repository, a folder of skills, or one skill. Its skills are saved whole.
 * An installed plugin given by its id is installed again from where it came,
 * which updates it.
 */
export async function installPlugin(input: PluginPick | { plugin: string }): Promise<InstalledPlugin> {
	const pick = 'plugin' in input ? pickOf(await installed(input.plugin)) : input;
	const { source, named, fallback, marketplace } = await resolve(pick);
	const { files, sha } = await filesAt(source.repo, source.ref);
	const plugin = await readPlugin(files, source.path, named, fallback);
	if (plugin.skills.length === 0) {
		const servers = plugin.mcpServers.length ? ` It only adds MCP servers (${plugin.mcpServers.join(', ')}); add them in a repository's MCP servers.` : '';
		throw new InvalidInputError(`${plugin.name} has no skills Anton can use.${servers}${plugin.skipped.length ? ` ${plugin.skipped.join('; ')}` : ''}`);
	}
	return savePlugin({ id: idFor({ ...source, ref: null }, named), ...plugin, source, sha, marketplace, pick });
}

/** Files listed for a plugin; a whole large repository is cut short. */
const MAX_LISTED_FILES = 2000;

export type PluginPreview = {
	/** The id it installs as. */
	id: string;
	name: string;
	description: string;
	/** The repository and folder, at the commit read. */
	source: PluginSource;
	sha: string;
	marketplace: string | null;
	pick: PluginPick;
	skills: Array<{ name: string; description: string; folder: string; license: string | null }>;
	mcpServers: string[];
	skipped: string[];
	/** Paths in the repository under the plugin's folder. */
	files: string[];
	truncated: boolean;
	/** The plugin's README, when it has one. */
	readme: string | null;
	/** How it is installed, when it is. */
	installed: { sha: string; enabled: boolean } | null;
	/** A newer commit of an installed plugin, when there is one. */
	update: string | null;
};

/**
 * A plugin as installing it would save it, without saving anything: its
 * skills, MCP servers, what would be left out and every file in its folder.
 * An installed plugin shows as it was installed, with any newer commit.
 */
export async function previewPlugin(input: PluginPick | { plugin: string }): Promise<PluginPreview> {
	const saved = 'plugin' in input ? await installed(input.plugin) : null;
	const pick = saved ? pickOf(saved) : (input as PluginPick);
	const { source, named, fallback, marketplace } = await resolve(pick);
	const { files, sha } = await filesAt(source.repo, saved?.sha ?? source.ref);
	const plugin = await readPlugin(files, source.path, named, fallback);
	const id = idFor({ ...source, ref: null }, named);
	const current = saved ?? (await getPlugin(id));
	const prefix = source.path ? `${source.path}/` : '';
	const all = files.paths.filter((path) => path.startsWith(prefix)).sort();
	const readme = all.find((path) => /^readme\.md$/i.test(path.slice(prefix.length))) ?? null;
	// An installed plugin shows as installed, so a newer commit is looked up; otherwise this is the newest.
	const newest = saved ? await newestCommit(source).catch(() => null) : sha;
	return {
		id,
		name: plugin.name,
		description: plugin.description,
		source: { ...source, ref: sha },
		sha,
		marketplace,
		pick,
		skills: plugin.skills.map((skill) => ({ name: skill.name, description: skill.description, folder: skill.folder ?? '', license: skill.license ?? null })),
		mcpServers: plugin.mcpServers,
		skipped: plugin.skipped,
		files: all.slice(0, MAX_LISTED_FILES),
		truncated: all.length > MAX_LISTED_FILES,
		readme,
		installed: current ? { sha: current.sha, enabled: current.enabled } : null,
		update: current && newest && newest !== current.sha ? newest : null,
	};
}

/** The newest commit of a plugin's branch; null for one pinned to a commit, which never moves. */
async function newestCommit(source: PluginSource): Promise<string | null> {
	if (/^[0-9a-f]{40}$/.test(source.ref ?? '')) return null;
	const git = getProviders().git;
	return git.resolveRef(source.repo, source.ref ?? (await git.getRepo(source.repo)).defaultBranch);
}

/** One file of a repository at a commit, as a preview shows it; null when there is none or it is too large to keep. */
export async function pluginFile(repo: string, sha: string, path: string): Promise<Uint8Array | null> {
	if (!parseGitHub(repo) || !/^[0-9a-f]{40}$/.test(sha)) throw new InvalidInputError('Give a repository and a commit');
	return (await snapshotFiles(repo, sha)).read(path);
}

export type GitHubSkill = { address: string; repo: string; name: string; description: string };
export type GitHubRepo = { address: string; description: string; stars: number };
export type GitHubSearch = { skills: GitHubSkill[]; repos: GitHubRepo[]; problems: string[] };

const searches = new Map<string, { at: number; result: Promise<GitHubSearch> }>();
const SEARCH_TTL_MS = 10 * 60_000;
const KEEP_SEARCHES = 100;

/** A skill found by its SKILL.md, named and described by its front matter. */
async function skillHit(hit: FileHit): Promise<GitHubSkill | null> {
	const folder = hit.path.split('/').slice(0, -1).join('/');
	const bytes = await getProviders().git.file(hit.repo, hit.ref, hit.path).catch(() => null);
	if (!bytes) return null;
	const { data } = parseFrontMatter(new TextDecoder().decode(bytes));
	const name = typeof data.name === 'string' && data.name ? data.name : folder.split('/').pop() || hit.repo.split('/')[1];
	const description = typeof data.description === 'string' ? data.description : '';
	return { address: [hit.repo, folder].filter(Boolean).join('/'), repo: hit.repo, name, description };
}

const problem = (what: string, error: unknown) =>
	error instanceof Error && /rate limit|403|429/i.test(error.message) ? `GitHub's ${what} search limit is reached; it frees up within a minute.` : `GitHub ${what} search failed.`;

async function runSearch(query: string): Promise<GitHubSearch> {
	const git = getProviders().git;
	const [files, repos] = await Promise.allSettled([git.searchFiles(query, 'SKILL.md', 12), git.searchRepos(`${query} skill in:name,description,topics,readme`, 10)]);
	const problems: string[] = [];
	if (files.status === 'rejected') problems.push(problem('code', files.reason));
	if (repos.status === 'rejected') problems.push(problem('repository', repos.reason));
	const hits = files.status === 'fulfilled' ? files.value : [];
	const unique = hits.filter((hit, index) => hits.findIndex((other) => other.repo === hit.repo && other.path === hit.path) === index);
	const skills = (await Promise.all(unique.map(skillHit))).filter((hit): hit is GitHubSkill => hit !== null);
	return {
		skills,
		repos: repos.status === 'fulfilled' ? repos.value.map((repo) => ({ address: repo.fullName, description: repo.description, stars: repo.stars })) : [],
		problems,
	};
}

/**
 * Skills and repositories of skills on GitHub matching a search, live:
 * SKILL.md files whose contents match, and repositories that mention skills.
 * Each search is kept a while, as GitHub allows only a few a minute.
 */
export async function searchGitHub(raw: string): Promise<GitHubSearch> {
	const query = raw.trim().replace(/\s+/g, ' ').slice(0, 100);
	if (query.length < 2) return { skills: [], repos: [], problems: [] };
	const key = query.toLowerCase();
	const cached = searches.get(key);
	if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.result;
	const result = runSearch(query);
	searches.set(key, { at: Date.now(), result });
	// A search that failed outright, or hit a limit, is tried again next time.
	result.then((found) => found.problems.length && searches.delete(key), () => searches.delete(key));
	if (searches.size > KEEP_SEARCHES) searches.delete(searches.keys().next().value!);
	return result;
}

export type PluginView = Omit<InstalledPlugin, 'skills'> & { skills: Array<{ name: string; description: string; active: boolean }> };

/** Whether each skill of each plugin is used: the plugin is on, and no earlier plugin has a skill by that name. */
function marked(plugins: InstalledPlugin[]): Array<{ plugin: InstalledPlugin; skill: ParsedSkill; active: boolean }> {
	const taken = new Set<string>();
	return plugins.flatMap((plugin) =>
		plugin.skills.map((skill) => {
			const active = plugin.enabled && !taken.has(skill.name);
			if (active) taken.add(skill.name);
			return { plugin, skill, active };
		}),
	);
}

/** Installed plugins, each skill marked inactive when its plugin is off or an earlier plugin has its name. */
export async function pluginsView(): Promise<PluginView[]> {
	const plugins = await listPlugins();
	const all = marked(plugins);
	return plugins.map(({ skills: _skills, ...plugin }) => ({
		...plugin,
		skills: all.filter((item) => item.plugin.id === plugin.id).map(({ skill, active }) => ({ name: skill.name, description: skill.description, active })),
	}));
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
	if (!(await getPlugin(id))) throw new NotFoundError('Plugin not found');
	await setPluginEnabled(id, enabled);
}

export async function removePlugin(id: string): Promise<void> {
	await deletePlugin(id);
}

/** A skill as Flue mounts it (its `SkillDefinition`), with binary files as bytes. */
export type MountedSkill = {
	name: string;
	description: string;
	instructions: string;
	license?: string;
	files: Record<string, string | Uint8Array>;
};

function toMounted(skill: ParsedSkill): MountedSkill {
	const files = Object.fromEntries(
		Object.entries(skill.files).map(([path, file]) => [path, 'text' in file ? file.text : new Uint8Array(Buffer.from(file.base64, 'base64'))]),
	);
	return { name: skill.name, description: skill.description, instructions: skill.instructions, ...(skill.license ? { license: skill.license } : {}), files };
}

/** A repo's skills and instructions at one commit, read from GitHub once. */
type RepoContext = { agents: MountedSkill[]; claude: MountedSkill[]; instructions: string };
const NO_CONTEXT: RepoContext = { agents: [], claude: [], instructions: '' };
const repoContexts = new Map<string, Promise<RepoContext>>();
const KEEP_CONTEXTS = 50;

async function readRepoContext(repo: string, sha: string): Promise<RepoContext> {
	const git = getProviders().git;
	const all = await git.tree(repo, sha);
	const paths = all.filter((path) => /^\.(agents|claude)\/skills\//.test(path) || path === 'AGENTS.md' || path === 'CLAUDE.md');
	const known = new Set(paths);
	const files: RepoFiles = { paths, read: async (path) => (known.has(path) ? git.file(repo, sha, path) : null) };
	const { agents, claude } = await readRepoSkills(files);
	const parts: string[] = [];
	for (const name of ['AGENTS.md', 'CLAUDE.md']) {
		const bytes = await files.read(name);
		if (bytes) parts.push(new TextDecoder().decode(bytes).trim());
	}
	return { agents: agents.map(toMounted), claude: claude.map(toMounted), instructions: parts.join('\n\n').slice(0, MAX_INSTRUCTIONS) };
}

function repoContext(repo: string, sha: string): Promise<RepoContext> {
	const key = `${repo}@${sha}`;
	let pending = repoContexts.get(key);
	if (!pending) {
		pending = readRepoContext(repo, sha);
		repoContexts.set(key, pending);
		pending.catch(() => repoContexts.delete(key));
		if (repoContexts.size > KEEP_CONTEXTS) repoContexts.delete(repoContexts.keys().next().value!);
	}
	return pending;
}

/** What each task's agent mounts while it renders, which is synchronous; filled before every message. */
const primed = new Map<string, { repo: RepoContext; plugins: MountedSkill[] }>();

export async function primeSkills(id: string): Promise<void> {
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	if (!session || !project) return;
	const repo = await repoContext(project.repoFullName, session.baseSha).catch((error: unknown) => {
		logProblem('warn', "Could not read the repository's skills", error, id);
		return NO_CONTEXT;
	});
	const installed = marked(await listPlugins())
		.filter((item) => item.active)
		.map((item) => toMounted(item.skill));
	primed.set(id, { repo, plugins: installed });
}

/**
 * The skills a task's agent mounts. The repo's own come first and win a
 * name: `.agents/skills` is read from the snapshot while read-only and by Flue
 * itself once there is a sandbox, so only `.claude/skills` is mounted then.
 */
export function skillsFor(id: string, workspace: boolean): MountedSkill[] {
	const { repo, plugins } = primed.get(id) ?? { repo: NO_CONTEXT, plugins: [] };
	const own = [...repo.agents, ...repo.claude];
	const taken = new Set(own.map((skill) => skill.name));
	return [...(workspace ? repo.claude : own), ...plugins.filter((skill) => !taken.has(skill.name))];
}

/** The repo's AGENTS.md and CLAUDE.md, for a task without a sandbox; one with a sandbox reads them from its files. */
export function repoInstructionsFor(id: string): string {
	return primed.get(id)?.repo.instructions ?? '';
}

/** The skills a task can be asked to use by name, as `/name` in the composer. */
export async function sessionSkills(id: string): Promise<Array<{ name: string; description: string }>> {
	if (!primed.has(id)) await primeSkills(id);
	return skillsFor(id, false).map(({ name, description }) => ({ name, description }));
}
