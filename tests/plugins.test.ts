import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontMatter, parseGitHub, readCatalog, readPlugin, readRepoSkills, type RepoFiles } from '../src/core/plugins.ts';

/** A repository held in memory. */
function repo(files: Record<string, string>): RepoFiles {
	return { paths: Object.keys(files), read: async (path) => (path in files ? new TextEncoder().encode(files[path]) : null) };
}

const skill = (name: string, description = `Does ${name}. Use when asked to ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSteps for ${name}.\n`;

test('front matter: plain, quoted and folded values, and metadata', () => {
	const { data, body } = parseFrontMatter(
		'---\nname: pdf\ndescription: >\n  Fill and merge PDFs.\n  Use for any PDF.\nlicense: "Apache-2.0"\nmetadata:\n  author: acme\n  version: \'1.0\'\n---\nBody here\n',
	);
	assert.deepEqual(data, { name: 'pdf', description: 'Fill and merge PDFs. Use for any PDF.', license: 'Apache-2.0', metadata: { author: 'acme', version: '1.0' } });
	assert.equal(body, 'Body here\n');
	assert.deepEqual(parseFrontMatter('No front matter').data, {});
});

test('GitHub addresses: owner/repo, folders, URLs with a branch', () => {
	assert.deepEqual(parseGitHub('acme/tools'), { repo: 'acme/tools', path: '', ref: null });
	assert.deepEqual(parseGitHub('acme/tools/skills/pdf'), { repo: 'acme/tools', path: 'skills/pdf', ref: null });
	assert.deepEqual(parseGitHub('https://github.com/acme/tools/tree/dev/skills/pdf'), { repo: 'acme/tools', path: 'skills/pdf', ref: 'dev' });
	assert.deepEqual(parseGitHub('https://github.com/acme/tools.git'), { repo: 'acme/tools', path: '', ref: null });
	assert.equal(parseGitHub('https://gitlab.com/acme/tools'), null);
});

const home = { repo: 'acme/market', path: '', ref: 'abc' };

test("Claude Code's marketplace: named plugins here and in other repositories", async () => {
	const files = repo({
		'.claude-plugin/marketplace.json': JSON.stringify({
			name: 'acme',
			owner: { name: 'Acme' },
			plugins: [
				{ name: 'docs', description: 'Document skills', source: './', strict: false, skills: ['./skills/pdf', './skills/xlsx'] },
				{ name: 'lint', source: { source: 'github', repo: 'acme/lint', sha: 'f00' } },
				{ name: 'db', source: { source: 'git-subdir', url: 'https://github.com/acme/mono.git', path: 'plugins/db', ref: 'v2' } },
				{ name: 'npm-only', source: { source: 'npm', package: '@acme/x' } },
			],
		}),
	});
	assert.deepEqual(await readCatalog(files, home), [
		{ name: 'docs', description: 'Document skills', source: home, skills: ['./skills/pdf', './skills/xlsx'] },
		{ name: 'lint', description: '', source: { repo: 'acme/lint', path: '', ref: 'f00' }, skills: null },
		{ name: 'db', description: '', source: { repo: 'acme/mono', path: 'plugins/db', ref: 'v2' }, skills: null },
	]);
});

test("Devin's marketplace: folders named by their own manifests, and pinned repositories", async () => {
	const files = repo({
		'.devin-plugin/plugin.json': JSON.stringify({
			name: 'market',
			optionalPlugins: ['./plugins/notes', { source: 'url', url: 'https://github.com/acme/skills.git', sha: 'beef' }],
		}),
		'plugins/notes/.devin-plugin/plugin.json': JSON.stringify({ name: 'notes', displayName: 'Notes', description: 'Take notes' }),
	});
	const entries = await readCatalog(files, home);
	assert.deepEqual(
		entries.map((entry) => [entry.name, entry.description, entry.source]),
		[
			['Notes', 'Take notes', { repo: 'acme/market', path: 'plugins/notes', ref: 'abc' }],
			['acme/skills', 'From github.com/acme/skills', { repo: 'acme/skills', path: '', ref: 'beef' }],
		],
	);
});

test('a plugin: Agent Plugins manifest, skills/ and its MCP servers; bad skills are skipped', async () => {
	const files = repo({
		'plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'cloud', description: 'Cloud tools' }),
		'mcp.json': JSON.stringify({ mcpServers: { cloud: { type: 'streamable-http', url: 'https://mcp.example.com' } } }),
		'skills/deploy/SKILL.md': skill('deploy'),
		'skills/deploy/scripts/run.sh': 'echo deploy',
		'skills/Bad_Name/SKILL.md': skill('Bad_Name'),
		'skills/empty/SKILL.md': '---\nname: empty\n---\nNo description',
	});
	const plugin = await readPlugin(files, '');
	assert.equal(plugin.name, 'cloud');
	assert.deepEqual(
		plugin.skills.map((item) => [item.name, Object.keys(item.files)]),
		[['deploy', ['scripts/run.sh']]],
	);
	assert.match(plugin.skills[0].instructions, /Steps for deploy/);
	assert.deepEqual(plugin.mcpServers, ['cloud']);
	assert.equal(plugin.skipped.length, 2);
});

test('one skill folder installs as a plugin of its own, and a marketplace can pick folders', async () => {
	const files = repo({ 'skills/pdf/SKILL.md': skill('pdf'), 'skills/xlsx/SKILL.md': skill('xlsx'), 'skills/pptx/SKILL.md': skill('pptx') });
	const single = await readPlugin(files, 'skills/pdf');
	assert.deepEqual([single.name, single.skills.map((item) => item.name)], ['pdf', ['pdf']]);
	const picked = await readPlugin(files, '', ['./skills/pdf', './skills/xlsx'], 'docs');
	assert.deepEqual([picked.name, picked.skills.map((item) => item.name)], ['docs', ['pdf', 'xlsx']]);
});

test("a repository's own skills: .agents/skills first, .claude/skills for names not taken", async () => {
	const { agents, claude } = await readRepoSkills(
		repo({ '.agents/skills/release/SKILL.md': skill('release'), '.claude/skills/release/SKILL.md': skill('release'), '.claude/skills/triage/SKILL.md': skill('triage') }),
	);
	assert.deepEqual(agents.map((item) => item.name), ['release']);
	assert.deepEqual(claude.map((item) => item.name), ['triage']);
});
