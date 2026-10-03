import { createHash } from 'node:crypto';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import {
	type CatalogEntry,
	type ParsedSkill,
	type PluginSource,
	parseGitHub,
	readCatalog,
	readPlugin,
	readRepoSkills,
	type RepoFiles,
} from '../core/plugins.ts';
import { deletePlugin, getPlugin, type InstalledPlugin, listPlugins, savePlugin, setPluginEnabled } from '../db/plugins.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';
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
const catalogs = new Map<string, { at: number; entries: CatalogEntry[] }>();

/** What one marketplace offers, and which of it is installed. */
export async function catalog(marketplace: string): Promise<CatalogItem[]> {
	const found = parseGitHub(marketplace);
	if (!found) throw new InvalidInputError(`"${marketplace}" is not a GitHub repository`);
	const key = marketplace.toLowerCase();
	let cached = catalogs.get(key);
	if (!cached || Date.now() - cached.at > CATALOG_TTL_MS) {
		const { files, sha } = await filesAt(found.repo, found.ref);
		cached = { at: Date.now(), entries: await readCatalog(files, { ...found, ref: sha }) };
		catalogs.set(key, cached);
	}
	const installed = new Set((await listPlugins()).map((plugin) => plugin.id));
	return cached.entries.map((entry) => {
		const id = idFor({ ...entry.source, ref: null }, entry.skills);
		return { ...entry, id, installed: installed.has(id) };
	});
}

/**
 * Installs a plugin from a marketplace by name, or from a GitHub address: a
 * repository, a folder of skills, or one skill. Its skills are saved whole.
 */
export async function installPlugin(input: { marketplace: string; name: string } | { address: string }): Promise<InstalledPlugin> {
	let source: PluginSource;
	let named: string[] | null = null;
	let fallback = '';
	let marketplace: string | null = null;
	if ('address' in input) {
		const found = parseGitHub(input.address);
		if (!found) throw new InvalidInputError('Give a GitHub repository, such as owner/repo or owner/repo/skills/name, or its URL');
		source = found;
	} else {
		const entry = (await catalog(input.marketplace)).find((item) => item.name === input.name);
		if (!entry) throw new NotFoundError(`${input.marketplace} does not list ${input.name}`);
		({ source, skills: named, name: fallback } = entry);
		marketplace = input.marketplace;
	}
	const { files, sha } = await filesAt(source.repo, source.ref);
	const plugin = await readPlugin(files, source.path, named, fallback);
	if (plugin.skills.length === 0) {
		const servers = plugin.mcpServers.length ? ` It only adds MCP servers (${plugin.mcpServers.join(', ')}); add them in a repository's MCP servers.` : '';
		throw new InvalidInputError(`${plugin.name} has no skills Anton can use.${servers}${plugin.skipped.length ? ` ${plugin.skipped.join('; ')}` : ''}`);
	}
	return savePlugin({ id: idFor({ ...source, ref: null }, named), ...plugin, source, sha, marketplace });
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
