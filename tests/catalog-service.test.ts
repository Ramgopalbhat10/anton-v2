import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { GitHost, ModelCatalog, ObjectStore, SandboxProvider } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-catalog-'));
process.env.ANTON_DATA_DIR = path.join(dir, 'data');
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function repository(name: string, files: Record<string, string>) {
	const root = path.join(dir, name);
	mkdirSync(root);
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'user.name', 'Test');
	git(root, 'config', 'user.email', 'test@example.com');
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), text);
	}
	git(root, 'add', '.');
	git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Skills');
	return root;
}
const skill = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\nInstructions for ${name}.`;
const source = repository('source', {
	'plugins/docs/skills/pdf/SKILL.md': skill('pdf'),
	'plugins/docs/skills/xlsx/SKILL.md': skill('xlsx'),
	'plugins/engineering/skills/tdd/SKILL.md': skill('tdd'),
});
git(source, 'tag', 'stable');
const pinned = git(source, 'rev-parse', 'stable');
// A later default-branch commit must not replace the marketplace's pinned source.
writeFileSync(path.join(source, 'plugins/docs/skills/pdf/SKILL.md'), skill('changed'));
git(source, 'add', '.');
git(source, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Later version');
const market = repository('market', {
	'.claude-plugin/marketplace.json': JSON.stringify({
		plugins: [
			{ name: 'docs', source: { source: 'github', repo: 'acme/source', path: 'plugins/docs', ref: 'stable' }, skills: ['skills/pdf'] },
			{ name: 'engineering', source: { source: 'github', repo: 'acme/source', path: 'plugins/engineering', ref: 'stable' } },
		],
	}),
});
const repos: Record<string, string> = { 'acme/market': market, 'acme/source': source };
/** Searches GitHub was asked to run. */
const searched: string[] = [];
const host: Pick<GitHost, 'getRepo' | 'resolveRef' | 'archive' | 'file' | 'searchFiles' | 'searchRepos'> = {
	getRepo: async (fullName) => ({ fullName, defaultBranch: 'main', private: false }),
	resolveRef: async (repo, ref) => git(repos[repo], 'rev-parse', ref),
	archive: async (repo, sha) => new Blob([execFileSync('git', ['archive', '--format=tar.gz', '--prefix=snapshot/', sha], { cwd: repos[repo] })]).stream(),
	file: async (repo, ref, file) => new TextEncoder().encode(git(repos[repo], 'show', `${ref}:${file}`)),
	searchFiles: async (query, filename) => {
		searched.push(`${filename}: ${query}`);
		return [
			{ repo: 'acme/source', path: 'plugins/docs/skills/pdf/SKILL.md', ref: pinned },
			{ repo: 'acme/source', path: 'plugins/docs/skills/pdf/SKILL.md', ref: pinned },
		];
	},
	searchRepos: async (query) => {
		searched.push(`repos: ${query}`);
		throw new Error('GitHub /search/repositories: 403 API rate limit exceeded');
	},
};
const { setProviders } = await import('../src/providers/index.ts');
setProviders({ git: host as GitHost, sandbox: {} as SandboxProvider, store: {} as ObjectStore, models: {} as ModelCatalog });
const { catalog, installPlugin, pluginFile, previewPlugin, searchGitHub } = await import('../src/services/plugins.ts');

test('concurrent external bundle browsing and cold-cache installation preserve the pinned single skill', async () => {
	const initial = await catalog('acme/market');
	assert.deepEqual(
		initial.map((item) => [item.name, item.browseable]),
		[
			['docs', true],
			['engineering', true],
		],
	);
	const [docs, engineering] = await Promise.all([catalog('acme/market', 'docs'), catalog('acme/market', 'engineering')]);
	assert.deepEqual(
		docs.map((item) => [item.name, item.source.path, item.source.ref]),
		[['docs/pdf', 'plugins/docs/skills/pdf', pinned]],
	);
	assert.deepEqual(
		engineering.map((item) => item.name),
		['engineering/tdd'],
	);
	assert.deepEqual(
		(await catalog('acme/market'))
			.filter((item) => item.bundle)
			.map((item) => item.name)
			.sort(),
		['docs/pdf', 'engineering/tdd'],
	);
	const clock = Date.now;
	const future = clock() + 11 * 60_000;
	Date.now = () => future;
	try {
		const installed = await installPlugin({ marketplace: 'acme/market', name: 'docs/pdf' });
		assert.deepEqual(
			installed.skills.map((item) => item.name),
			['pdf'],
		);
		assert.equal(installed.sha, pinned);
		assert.equal(installed.source.path, 'plugins/docs/skills/pdf');
		assert.equal((await catalog('acme/market', 'docs'))[0].installed, true);
	} finally {
		Date.now = clock;
	}
});

test('a plugin can be looked through before it is installed, and an installed one shows its newer commit', async () => {
	const docs = await previewPlugin({ marketplace: 'acme/market', name: 'docs' });
	assert.equal(docs.sha, pinned);
	assert.deepEqual(
		docs.skills.map((item) => [item.name, item.folder]),
		[['pdf', 'plugins/docs/skills/pdf']],
	);
	assert.deepEqual(docs.files, ['plugins/docs/skills/pdf/SKILL.md', 'plugins/docs/skills/xlsx/SKILL.md'], 'every file in its folder');
	assert.equal(docs.installed, null);
	assert.match(new TextDecoder().decode((await pluginFile('acme/source', pinned, 'plugins/docs/skills/xlsx/SKILL.md'))!), /name: xlsx/);
	await assert.rejects(() => pluginFile('acme/source', 'main', 'README.md'), /commit/);

	const engineering = await installPlugin({ address: 'acme/source/plugins/engineering' });
	const before = await previewPlugin({ plugin: engineering.id });
	assert.deepEqual(before.installed, { sha: engineering.sha, enabled: true });
	assert.equal(before.update, null);

	writeFileSync(path.join(source, 'plugins/engineering/skills/tdd/SKILL.md'), skill('tdd').replace('Instructions', 'Better instructions'));
	git(source, 'add', '.');
	git(source, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Newer tdd');
	const newer = git(source, 'rev-parse', 'HEAD');
	const stale = await previewPlugin({ plugin: engineering.id });
	assert.equal(stale.sha, engineering.sha, 'shows what is installed');
	assert.equal(stale.update, newer);
	const updated = await installPlugin({ plugin: engineering.id });
	assert.equal(updated.id, engineering.id);
	assert.equal(updated.sha, newer);
	assert.match(updated.skills[0].instructions, /Better instructions/);
	assert.equal((await previewPlugin({ address: 'acme/source/plugins/engineering' })).update, null);
});

test('GitHub search finds skills by their SKILL.md, keeps each search a while, and says when a search is limited', async () => {
	const found = await searchGitHub('  pdf ');
	assert.deepEqual(found.skills, [{ address: 'acme/source/plugins/docs/skills/pdf', repo: 'acme/source', name: 'pdf', description: 'Does pdf.' }]);
	assert.deepEqual(found.repos, []);
	assert.match(found.problems[0], /limit/);
	assert.deepEqual(await searchGitHub('p'), { skills: [], repos: [], problems: [] }, 'too short to search');
	searched.length = 0;
	await searchGitHub('pdf');
	assert.equal(searched.length, 2, 'a limited search is tried again');
});
