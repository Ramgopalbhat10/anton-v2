import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createClient } from '@libsql/client';
import type { GitHost, ModelCatalog, ModelInfo } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-task-'));
process.env.ANTON_DATA_DIR = path.join(dir, 'data');
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A local bare repo stands in for GitHub.
const remote = path.join(dir, 'remote.git');
const seed = path.join(dir, 'seed');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
execFileSync('git', ['init', '-q', '-b', 'main', seed]);
git(seed, 'config', 'user.email', 'test@example.com');
git(seed, 'config', 'user.name', 'Test');
writeFileSync(path.join(seed, 'README.md'), '# demo\n');
writeFileSync(path.join(seed, 'old.txt'), 'remove me\n');
git(seed, 'add', '.');
git(seed, 'commit', '-q', '-m', 'init');
git(seed, 'push', '-q', remote, 'main');

const pullRequests: string[] = [];
const fakeHost: GitHost = {
	name: 'fake',
	getRepo: async (fullName) => ({ fullName, defaultBranch: 'main', private: false }),
	listBranches: async () => ['main'],
	resolveRef: async (_repo, ref) => git(remote, 'rev-parse', ref),
	tree: async (_repo, sha) => git(remote, 'ls-tree', '-r', '--name-only', sha).split('\n'),
	file: async (_repo, sha, file) => new TextEncoder().encode(`${git(remote, 'show', `${sha}:${file}`)}\n`),
	cloneUrl: () => remote,
	gitAuthEnv: () => ({}),
	openPullRequest: async (input) => {
		pullRequests.push(input.head);
		return 'https://example.test/pull/1';
	},
};

const model = (id: string, reasoning: ModelInfo['reasoning'], defaultReasoning: ModelInfo['reasoning'][number]): ModelInfo => ({
	id,
	name: id,
	vendor: 'Test',
	description: '',
	createdAt: 0,
	contextLength: 128_000,
	maxOutput: null,
	price: { input: 0, output: 0 },
	vision: false,
	reasoning,
	defaultReasoning,
});
const fakeCatalog: ModelCatalog = {
	name: 'fake',
	list: async () => [
		model('openrouter/~deepseek/deepseek-flash-latest', ['low', 'high', 'max'], 'high'),
		model('openrouter/moonshotai/kimi-k2.6', ['off', 'low', 'medium', 'high'], 'medium'),
		model('openrouter/plain/no-reasoning', [], 'off'),
	],
};

const { useDatabase } = await import('../src/db/client.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { addProject } = await import('../src/services/projects.ts');
const sessions = await import('../src/services/sessions.ts');
const files = await import('../src/services/files.ts');
const { machineFor } = await import('../src/services/workspace.ts');
const { saveCheckpoint } = await import('../src/services/checkpoints.ts');
const { openPullRequest } = await import('../src/services/pull-requests.ts');

useDatabase(createClient({ url: `file:${path.join(dir, 'anton.db')}` }));
setProviders({
	sandbox: localSandboxProvider(path.join(dir, 'data')),
	store: diskStore(path.join(dir, 'data', 'objects')),
	git: fakeHost,
	models: fakeCatalog,
});

const text = (bytes: Uint8Array | null) => new TextDecoder().decode(bytes ?? new Uint8Array());

test('a task runs, checkpoints, stops, stays viewable, and opens a pull request', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, title: 'Fix the readme' });
	assert.match(session.branch, /^anton\/fix-the-readme-/);
	assert.equal(session.status, 'stopped');

	const before = await files.fileTree(session.id);
	assert.equal(before.source, 'base');
	assert.deepEqual(before.paths.sort(), ['README.md', 'old.txt']);

	const machine = await machineFor(session.id);
	const repo = `${machine.root}/repo`;
	await machine.exec(`cd ${repo} && echo '# demo, fixed' > README.md && rm old.txt && echo new > added.txt`);
	await machine.exec(`echo report > ${machine.root}/outputs/report.md`);

	sessions.invalidateRunning();
	const live = await files.changesView(session.id);
	assert.equal(live.source, 'live');
	assert.match(live.patch, /\+# demo, fixed/);
	assert.match(live.patch, /added\.txt/);
	assert.equal((live.patch.match(/^diff --git/gm) ?? []).length, 3, 'each change appears once');

	await saveCheckpoint(session.id, machine);
	await sessions.stopSession(session.id);

	const saved = await files.fileTree(session.id);
	assert.equal(saved.source, 'saved');
	assert.deepEqual(saved.paths, ['README.md', 'added.txt']);
	assert.equal(text(await files.readFile(session.id, 'README.md')), '# demo, fixed\n');
	assert.match((await files.changesView(session.id)).patch, /old\.txt/);
	assert.deepEqual(
		(await files.outputsView(session.id)).outputs.map((output) => output.path),
		['report.md'],
	);
	assert.equal(text(await files.readOutputFile(session.id, 'report.md')), 'report\n');
	await assert.rejects(() => files.readFile(session.id, '../secrets'));

	const url = await openPullRequest(session.id, { title: 'Fix the readme', body: '' });
	assert.equal(url, 'https://example.test/pull/1');
	assert.deepEqual(pullRequests, [session.branch]);
	assert.equal(git(remote, 'show', `${session.branch}:README.md`), '# demo, fixed');
	assert.equal((await sessions.getSession(session.id)).prUrl, url);
});

test('the model and reasoning picker change what the agent reads', async () => {
	const project = await addProject('acme/demo');
	const session = await sessions.createSession({ projectId: project.id, model: 'openrouter/moonshotai/kimi-k2.6' });
	await sessions.primeModel(session.id);
	assert.deepEqual(sessions.modelFor(session.id), { model: 'openrouter/moonshotai/kimi-k2.6', reasoning: 'medium' });

	await sessions.setModel(session.id, { model: 'openrouter/~deepseek/deepseek-flash-latest', reasoning: 'max' });
	await sessions.primeModel(session.id);
	assert.deepEqual(sessions.modelFor(session.id), { model: 'openrouter/~deepseek/deepseek-flash-latest', reasoning: 'max' });

	// A level the new model does not offer falls back to its default.
	await sessions.setModel(session.id, { reasoning: 'off' });
	await sessions.primeModel(session.id);
	assert.equal(sessions.modelFor(session.id).reasoning, 'high');

	await sessions.setModel(session.id, { model: 'openrouter/plain/no-reasoning' });
	await sessions.primeModel(session.id);
	assert.equal(sessions.modelFor(session.id).reasoning, 'off');

	await assert.rejects(() => sessions.setModel(session.id, { model: 'openrouter/made/up' }), /Unknown model/);
});
