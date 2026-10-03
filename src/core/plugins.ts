/**
 * Agent Skills, plugins and marketplaces, read from a repository's files.
 *
 * A skill is a folder with a SKILL.md (https://agentskills.io/specification).
 * A plugin bundles skills; its manifest is `.devin-plugin/plugin.json`,
 * `.claude-plugin/plugin.json` or an Agent Plugins `plugin.json`, found in that
 * order as Devin does, and a folder of skills with no manifest is a plugin too.
 * A marketplace lists plugins, here or in other repositories: Claude Code's
 * `marketplace.json` (also used by Codex and Cursor) or a Devin manifest's
 * `optionalPlugins`. Only GitHub sources are read.
 */

/** A repository at one commit: its file paths, and their contents on request. */
export type RepoFiles = { paths: string[]; read(path: string): Promise<Uint8Array | null> };

/** Where a plugin lives: a folder of a GitHub repository at a commit or branch (null for its default branch). */
export type PluginSource = { repo: string; path: string; ref: string | null };

export type CatalogEntry = {
	name: string;
	description: string;
	source: PluginSource;
	/** Skill folders the marketplace names for this plugin, when it names them. */
	skills: string[] | null;
};

export type SkillFile = { text: string } | { base64: string };

export type ParsedSkill = { name: string; description: string; instructions: string; license?: string; files: Record<string, SkillFile> };

export type ParsedPlugin = {
	name: string;
	description: string;
	skills: ParsedSkill[];
	/** MCP servers the plugin declares. Anton does not run them; a repository's MCP settings can add them. */
	mcpServers: string[];
	/** What was left out, and why. */
	skipped: string[];
};

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 1024;
/** Supporting files beyond these are left out; instructions point at them, and a skill rarely needs big ones. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 100;
const MANIFESTS = ['.devin-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json'];
const MARKETPLACES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', '.cursor-plugin/marketplace.json'];

const join = (...parts: string[]) =>
	parts
		.flatMap((part) => part.split('/'))
		.filter((part) => part && part !== '.')
		.join('/');
const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? '';
const decoder = new TextDecoder('utf-8', { fatal: true });
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const unquote = (value: string) => {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		const inner = trimmed.slice(1, -1);
		return trimmed.startsWith('"') ? inner.replace(/\\"/g, '"') : inner.replace(/''/g, "'");
	}
	return trimmed;
};

/**
 * The YAML front matter of a SKILL.md and the body after it. Enough YAML for
 * what skills use: plain, quoted and folded (`>`, `|`) values, and one level of
 * nesting for `metadata`.
 */
export function parseFrontMatter(source: string): { data: Record<string, string | Record<string, string>>; body: string } {
	const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
	if (!match) return { data: {}, body: source };
	const lines = match[1].split(/\r?\n/);
	const data: Record<string, string | Record<string, string>> = {};
	for (let index = 0; index < lines.length; index += 1) {
		const top = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[index]);
		if (!top) continue;
		const [, key, rest] = top;
		const nested: string[] = [];
		while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || lines[index + 1].trim() === '')) nested.push(lines[(index += 1)]);
		const block = /^([>|])[+-]?$/.exec(rest.trim());
		if (block) {
			const kept = nested.map((line) => line.trim());
			data[key] = (block[1] === '>' ? kept.filter(Boolean).join(' ') : kept.join('\n')).trim();
		} else if (rest.trim() === '' && nested.some((line) => /^\s+[A-Za-z0-9_-]+:/.test(line))) {
			const map: Record<string, string> = {};
			for (const line of nested) {
				const pair = /^\s+([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
				if (pair) map[pair[1]] = unquote(pair[2]);
			}
			data[key] = map;
		} else {
			data[key] = unquote([rest, ...nested.map((line) => line.trim())].filter(Boolean).join(' '));
		}
	}
	return { data, body: source.slice(match[0].length) };
}

/** A skill folder as Flue mounts it, or why it cannot be. */
export async function readSkill(files: RepoFiles, dir: string): Promise<ParsedSkill | string> {
	const folder = join(dir);
	const bytes = await files.read(join(folder, 'SKILL.md'));
	if (!bytes) return `${folder || '.'} has no SKILL.md`;
	const { data, body } = parseFrontMatter(text(bytes));
	const name = str(data.name) || baseName(folder);
	const description = str(data.description);
	if (!SKILL_NAME.test(name) || name.length > 64) return `${name}: a skill name uses lowercase letters, digits and single dashes`;
	if (!description || description.length > MAX_DESCRIPTION) return `${name}: needs a description of at most ${MAX_DESCRIPTION} characters`;
	const out: Record<string, SkillFile> = {};
	let total = 0;
	const prefix = folder ? `${folder}/` : '';
	for (const path of files.paths.filter((path) => path.startsWith(prefix) && path !== `${prefix}SKILL.md`)) {
		if (Object.keys(out).length >= MAX_FILES) break;
		const content = await files.read(path);
		if (!content || content.length > MAX_FILE_BYTES || total + content.length > MAX_SKILL_BYTES) continue;
		total += content.length;
		const relative = path.slice(prefix.length);
		try {
			out[relative] = { text: decoder.decode(content) };
		} catch {
			out[relative] = { base64: Buffer.from(content).toString('base64') };
		}
	}
	const license = str(data.license);
	return { name, description, instructions: body.trim(), ...(license ? { license } : {}), files: out };
}

/** Folders holding a SKILL.md: `dir` itself, or its direct children. */
function skillFolders(paths: Set<string>, dir: string): string[] {
	const folder = join(dir);
	if (paths.has(join(folder, 'SKILL.md'))) return [folder];
	const prefix = folder ? `${folder}/` : '';
	return [...paths]
		.filter((path) => path.startsWith(prefix) && /^[^/]+\/SKILL\.md$/.test(path.slice(prefix.length)))
		.map((path) => path.slice(0, -'/SKILL.md'.length))
		.sort();
}

async function readJson(files: RepoFiles, path: string): Promise<Record<string, unknown> | null> {
	const bytes = await files.read(path);
	if (!bytes) return null;
	try {
		const parsed = JSON.parse(text(bytes)) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

const asList = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

/** The manifest at a plugin's folder, first found in Devin's order. */
async function manifestAt(files: RepoFiles, dir: string): Promise<Record<string, unknown> | null> {
	const paths = new Set(files.paths);
	for (const name of MANIFESTS) {
		const path = join(dir, name);
		if (paths.has(path)) return readJson(files, path);
	}
	return null;
}

async function mcpServerNames(files: RepoFiles, dir: string, manifest: Record<string, unknown> | null): Promise<string[]> {
	const names = new Set<string>();
	const add = (value: unknown) => {
		const servers = isRecord(value) && isRecord(value.mcpServers) ? value.mcpServers : value;
		if (isRecord(servers)) for (const name of Object.keys(servers)) names.add(name);
	};
	if (manifest && isRecord(manifest.mcpServers)) add(manifest.mcpServers);
	for (const name of ['mcp.json', '.mcp.json']) add(await readJson(files, join(dir, name)));
	return [...names];
}

/**
 * The plugin in `dir`: its manifest's skills, the folders a marketplace named,
 * its `skills/` folder, or the folder itself when it is one skill.
 */
export async function readPlugin(files: RepoFiles, dir: string, named: string[] | null = null, fallbackName = ''): Promise<ParsedPlugin> {
	const paths = new Set(files.paths);
	const manifest = await manifestAt(files, dir);
	const listed = named ?? (manifest && 'skills' in manifest ? asList(manifest.skills) : ['skills']);
	const folders = [...new Set(listed.flatMap((path) => skillFolders(paths, join(dir, path))))];
	if (folders.length === 0 && !named) folders.push(...skillFolders(paths, dir).filter((folder) => folder === join(dir)));
	const skills: ParsedSkill[] = [];
	const skipped: string[] = [];
	for (const folder of folders) {
		const skill = await readSkill(files, folder);
		if (typeof skill === 'string') skipped.push(skill);
		else if (skills.some((existing) => existing.name === skill.name)) skipped.push(`${skill.name}: another skill has this name`);
		else skills.push(skill);
	}
	const name = str(manifest?.name) || fallbackName || (skills.length === 1 && folders[0] === join(dir) ? skills[0].name : baseName(dir));
	const description = str(manifest?.description) || (skills.length === 1 ? skills[0].description : '');
	return { name, description, skills, mcpServers: await mcpServerNames(files, dir, manifest), skipped };
}

/** A GitHub repository and folder from a URL or `owner/repo[/path]`, or null for anything else. */
export function parseGitHub(input: string): { repo: string; path: string; ref: string | null } | null {
	const value = input.trim().replace(/\.git$/, '');
	const url = /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/.exec(value) ??
		/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?()()$/.exec(value);
	if (url) return { repo: `${url[1]}/${url[2]}`, path: join(url[4] ?? ''), ref: url[3] || null };
	const short = /^([\w.-]+)\/([\w.-]+)((?:\/[^/]+)*)\/?$/.exec(value);
	if (short && !value.includes(':')) return { repo: `${short[1]}/${short[2]}`, path: join(short[3]), ref: null };
	return null;
}

/** A marketplace entry's source, relative paths resolved against the marketplace itself; null when it is not on GitHub. */
export function resolveSource(raw: unknown, marketplace: PluginSource, root = ''): PluginSource | null {
	if (typeof raw === 'string') {
		const value = raw.trim();
		if (value.startsWith('./') || value === '.' || value === './' || (!value.includes('/') && !value.includes(':'))) {
			return { ...marketplace, path: join(marketplace.path, root, value) };
		}
		return parseGitHub(value);
	}
	if (!isRecord(raw)) return null;
	const ref = str(raw.sha) || str(raw.ref) || null;
	const kind = str(raw.source);
	if (kind === 'github' && str(raw.repo)) {
		const found = parseGitHub(str(raw.repo));
		return found && { repo: found.repo, path: join(found.path, str(raw.path)), ref: ref ?? found.ref };
	}
	if (kind === 'url' || kind === 'git-subdir') {
		const found = parseGitHub(str(raw.url));
		return found && { repo: found.repo, path: join(found.path, kind === 'git-subdir' ? str(raw.path) : ''), ref: ref ?? found.ref };
	}
	return null;
}

/** A name for a plugin known only by where it lives. */
const sourceName = (source: PluginSource) => [source.repo, source.path].filter(Boolean).join('/');

/**
 * What a marketplace repository offers. Claude Code's format lists plugins
 * with names; Devin's lists folders and repositories, so local ones are named
 * from their own manifests. A repository with neither is one plugin.
 */
export async function readCatalog(files: RepoFiles, marketplace: PluginSource): Promise<CatalogEntry[]> {
	const paths = new Set(files.paths);
	for (const name of MARKETPLACES) {
		const listing = paths.has(join(marketplace.path, name)) ? await readJson(files, join(marketplace.path, name)) : null;
		if (!listing || !Array.isArray(listing.plugins)) continue;
		const root = isRecord(listing.metadata) ? str(listing.metadata.pluginRoot) : '';
		const entries: CatalogEntry[] = [];
		for (const plugin of listing.plugins) {
			if (!isRecord(plugin)) continue;
			const source = resolveSource(plugin.source, marketplace, root);
			if (!source || !str(plugin.name)) continue;
			const skills = plugin.strict === false || 'skills' in plugin ? asList(plugin.skills) : null;
			entries.push({ name: str(plugin.name), description: str(plugin.description), source, skills: skills && skills.length ? skills : null });
		}
		return entries;
	}
	const devin = await readJson(files, join(marketplace.path, '.devin-plugin/plugin.json'));
	const listed = devin ? [...(Array.isArray(devin.requiredPlugins) ? devin.requiredPlugins : []), ...(Array.isArray(devin.optionalPlugins) ? devin.optionalPlugins : [])] : [];
	if (listed.length) {
		const entries: CatalogEntry[] = [];
		for (const raw of listed) {
			const source = resolveSource(raw, marketplace);
			if (!source) continue;
			const local = source.repo === marketplace.repo && source.ref === marketplace.ref;
			const manifest = local ? await manifestAt(files, source.path) : null;
			entries.push({
				name: str(manifest?.displayName) || str(manifest?.name) || sourceName(source),
				description: str(manifest?.description) || (local ? '' : `From github.com/${sourceName(source)}`),
				source,
				skills: null,
			});
		}
		return entries;
	}
	const plugin = await readPlugin(files, marketplace.path);
	return plugin.skills.length ? [{ name: plugin.name, description: plugin.description, source: marketplace, skills: null }] : [];
}

/** A repository's own skills: `.agents/skills`, which every agent reads, then `.claude/skills` for names not taken. */
export async function readRepoSkills(files: RepoFiles): Promise<{ agents: ParsedSkill[]; claude: ParsedSkill[] }> {
	const paths = new Set(files.paths);
	const read = async (dir: string) => {
		const skills: ParsedSkill[] = [];
		for (const folder of skillFolders(paths, dir)) {
			const skill = await readSkill(files, folder);
			if (typeof skill !== 'string') skills.push(skill);
		}
		return skills;
	};
	const agents = await read('.agents/skills');
	const taken = new Set(agents.map((skill) => skill.name));
	return { agents, claude: (await read('.claude/skills')).filter((skill) => !taken.has(skill.name)) };
}
