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
const host: Pick<GitHost, 'getRepo' | 'resolveRef' | 'archive'> = {
	getRepo: async (fullName) => ({ fullName, defaultBranch: 'main', private: false }),
	resolveRef: async (repo, ref) => git(repos[repo], 'rev-parse', ref),
	archive: async (repo, sha) => new Blob([execFileSync('git', ['archive', '--format=tar.gz', '--prefix=snapshot/', sha], { cwd: repos[repo] })]).stream(),
};
const { setProviders } = await import('../src/providers/index.ts');
setProviders({ git: host as GitHost, sandbox: {} as SandboxProvider, store: {} as ObjectStore, models: {} as ModelCatalog });
const { catalog, installPlugin } = await import('../src/services/plugins.ts');

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
