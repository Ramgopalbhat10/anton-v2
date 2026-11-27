import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createClient } from '@libsql/client';
import { InvalidInputError, NotFoundError } from '../src/core/errors.ts';
import type { GitHost, ModelCatalog, PullRequestInfo } from '../src/core/ports.ts';
import { bareRemote } from './bare-remote.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-diff-files-'));
process.env.ANTON_DATA_DIR = path.join(dir, 'data');
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const remote = path.join(dir, 'remote.git');
const seed = path.join(dir, 'seed');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
execFileSync('git', ['init', '-q', '-b', 'main', seed]);
git(seed, 'config', 'user.email', 'test@example.com');
git(seed, 'config', 'user.name', 'Test');
git(seed, 'config', 'commit.gpgsign', 'false');
writeFileSync(path.join(seed, 'README.md'), 'line 1\nline 2\nline 3\n');
writeFileSync(path.join(seed, 'old.txt'), 'remove me\n');
writeFileSync(path.join(seed, 'rename-src.txt'), 'first\nsecond\n');
git(seed, 'add', '.');
git(seed, 'commit', '-q', '-m', 'init');
git(seed, 'push', '-q', remote, 'main');
const base0 = git(remote, 'rev-parse', 'main');

const pushes = bareRemote(remote);
const pulls: PullRequestInfo[] = [];
const fakeHost = {
	name: 'fake',
	getRepo: async (fullName: string) => ({ fullName, defaultBranch: 'main', private: false }),
	listBranches: async () => ['main'],
	resolveRef: async (_repo: string, ref: string) => git(remote, 'rev-parse', ref),
	tree: async (_repo: string, sha: string) => git(remote, 'ls-tree', '-r', '--name-only', sha).split('\n'),
	archive: async (_repo: string, sha: string) =>
		new Blob([execFileSync('git', ['archive', '--format=tar.gz', '--prefix=acme-demo/', sha], { cwd: remote })]).stream(),
	file: async (_repo: string, sha: string, filePath: string) => {
		try {
			return new Uint8Array(execFileSync('git', ['show', `${sha}:${filePath}`], { cwd: remote, stdio: ['ignore', 'pipe', 'ignore'] }));
		} catch {
			throw new NotFoundError(`missing ${sha}:${filePath}`);
		}
	},
	cloneUrl: () => remote,
	gitAuthEnv: () => ({}),
	branchHead: pushes.branchHead,
	pushCommits: pushes.pushCommits,
	pullRequest: async (url: string) => {
		const pull = pulls.find((item) => item.url === url);
		if (!pull) throw new NotFoundError(`missing pull request ${url}`);
		return pull;
	},
	mergeBase: async (_repo: string, a: string, b: string) => git(remote, 'merge-base', a, b),
} as unknown as GitHost;
const fakeCatalog: ModelCatalog = { name: 'fake', list: async () => [] };

const { useDatabase } = await import('../src/db/client.ts');
useDatabase(createClient({ url: `file:${path.join(dir, 'anton.db')}` }));
const { setProviders } = await import('../src/providers/index.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const local = localSandboxProvider(path.join(dir, 'data'));
const started: string[] = [];
setProviders({
	sandbox: {
		...local,
		acquire: async (request) => {
			started.push(request.key);
			return local.acquire(request);
		},
	},
	store: diskStore(path.join(dir, 'data', 'objects')),
	git: fakeHost,
	models: fakeCatalog,
});
const { config } = await import('../src/config.ts');
config.prepareImages = false;
config.prewarmSandbox = false;

const { addProject } = await import('../src/services/projects/projects.ts');
const { updateSession } = await import('../src/db/sessions.ts');
const { recordPullRequest } = await import('../src/db/pull-requests.ts');
const sessions = await import('../src/services/tasks/sessions.ts');
const { machineFor } = await import('../src/services/sandbox/workspace.ts');
const { saveCheckpoint } = await import('../src/services/git/checkpoints.ts');
const { MAX_DIFF_CONTEXT_BYTES, checkpointDiffFilesView, diffFilesView } = await import('../src/services/artifacts/files.ts');
const { pullRequestDiffFiles } = await import('../src/services/git/pull-requests.ts');

const project = await addProject('acme/demo');

test('diffFilesView reads live branch, unpushed, added, deleted, and renamed files without waking stopped tasks', async () => {
	const session = await sessions.createSession({ projectId: project.id, title: 'Context expansion' });
	assert.deepEqual(
		await diffFilesView(session.id, { path: 'README.md', scope: 'branch' }),
		{ oldText: 'line 1\nline 2\nline 3\n', newText: 'line 1\nline 2\nline 3\n' },
	);
	assert.equal(started.length, 0, 'viewing a fresh task before starting its sandbox starts no machine');

	const machine = await machineFor(session.id);
	assert.equal(started.length, 1);
	const repo = `${machine.root}/repo`;

	writeFileSync(path.join(repo, 'README.md'), 'line 1\ncommitted on branch\nline 3\n');
	writeFileSync(path.join(repo, 'added.txt'), 'hello\n');
	git(repo, 'config', 'user.email', 'test@example.com');
	git(repo, 'config', 'user.name', 'Test');
	git(repo, 'config', 'commit.gpgsign', 'false');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'pushed');
	git(repo, 'push', '-q', remote, `HEAD:refs/heads/${session.branch}`);
	const pushedSha = git(repo, 'rev-parse', 'HEAD');
	await updateSession(session.id, { pushedSha });

	writeFileSync(path.join(repo, 'README.md'), 'line 1\nunpushed change\nline 3\n');
	rmSync(path.join(repo, 'old.txt'));
	rmSync(path.join(repo, 'rename-src.txt'));
	writeFileSync(path.join(repo, 'rename-dst.txt'), 'first\nsecond changed\n');

	assert.deepEqual(await diffFilesView(session.id, { path: 'README.md', scope: 'branch' }), {
		oldText: 'line 1\nline 2\nline 3\n',
		newText: 'line 1\nunpushed change\nline 3\n',
	});
	assert.deepEqual(await diffFilesView(session.id, { path: 'README.md', scope: 'unpushed' }), {
		oldText: 'line 1\ncommitted on branch\nline 3\n',
		newText: 'line 1\nunpushed change\nline 3\n',
	});
	assert.deepEqual(await diffFilesView(session.id, { path: 'added.txt', scope: 'branch' }), {
		oldText: null,
		newText: 'hello\n',
	});
	assert.deepEqual(await diffFilesView(session.id, { path: 'old.txt', scope: 'branch' }), {
		oldText: 'remove me\n',
		newText: null,
	});
	assert.deepEqual(await diffFilesView(session.id, { path: 'rename-dst.txt', prevPath: 'rename-src.txt', scope: 'branch' }), {
		oldText: 'first\nsecond\n',
		newText: 'first\nsecond changed\n',
	});

	const checkpoint = await saveCheckpoint(session.id, machine);
	await sessions.stopSession(session.id);

	const startsBefore = started.length;
	assert.deepEqual(await diffFilesView(session.id, { path: 'README.md', scope: 'branch' }), {
		oldText: 'line 1\nline 2\nline 3\n',
		newText: 'line 1\nunpushed change\nline 3\n',
	});
	assert.deepEqual(await diffFilesView(session.id, { path: 'README.md', scope: 'unpushed' }), {
		oldText: 'line 1\ncommitted on branch\nline 3\n',
		newText: 'line 1\nunpushed change\nline 3\n',
	});
	assert.deepEqual(await diffFilesView(session.id, { path: 'added.txt', scope: 'branch' }), {
		oldText: null,
		newText: 'hello\n',
	});
	assert.deepEqual(await diffFilesView(session.id, { path: 'old.txt', scope: 'branch' }), {
		oldText: 'remove me\n',
		newText: null,
	});
	assert.deepEqual(await diffFilesView(session.id, { path: 'rename-dst.txt', prevPath: 'rename-src.txt', scope: 'branch' }), {
		oldText: 'first\nsecond\n',
		newText: 'first\nsecond changed\n',
	});
	assert.deepEqual(await checkpointDiffFilesView(session.id, checkpoint.at, { path: 'README.md' }), {
		oldText: 'line 1\nline 2\nline 3\n',
		newText: 'line 1\nunpushed change\nline 3\n',
	});
	assert.deepEqual(await checkpointDiffFilesView(session.id, checkpoint.at, { path: 'old.txt' }), {
		oldText: 'remove me\n',
		newText: null,
	});
	assert.equal(started.length, startsBefore, 'reading stopped diff/checkpoint files never starts a machine');
});

test('diffFilesView rejects traversal paths, binary files, and oversized files', async () => {
	const session = await sessions.createSession({ projectId: project.id, title: 'Limits' });
	const machine = await machineFor(session.id);
	const repo = `${machine.root}/repo`;

	await assert.rejects(diffFilesView(session.id, { path: '../secret', scope: 'branch' }), InvalidInputError);

	writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]));
	await assert.rejects(diffFilesView(session.id, { path: 'bin.dat', scope: 'branch' }), /Binary file cannot expand context/);

	writeFileSync(path.join(repo, 'huge.txt'), 'x'.repeat(MAX_DIFF_CONTEXT_BYTES + 1));
	await assert.rejects(diffFilesView(session.id, { path: 'huge.txt', scope: 'branch' }), /File too large to expand context/);

	mkdirSync(path.join(repo, 'nested'), { recursive: true });
	writeFileSync(path.join(repo, 'nested', 'ok.txt'), 'safe\n');
	assert.deepEqual(await diffFilesView(session.id, { path: 'nested/ok.txt', scope: 'branch' }), {
		oldText: null,
		newText: 'safe\n',
	});

	await sessions.stopSession(session.id);
});

test('pullRequestDiffFiles compares the 3-dot merge-base against the PR head commit', async () => {
	const session = await sessions.createSession({ projectId: project.id, title: 'PR context' });
	git(seed, 'checkout', '-q', '-b', 'feature-pr', base0);
	writeFileSync(path.join(seed, 'README.md'), 'line 1\nfeature change\nline 3\n');
	rmSync(path.join(seed, 'old.txt'));
	writeFileSync(path.join(seed, 'pr-added.txt'), 'from pr\n');
	git(seed, 'add', '-A');
	git(seed, 'commit', '-q', '-m', 'pr work');
	git(seed, 'push', '-q', remote, 'feature-pr');
	const headSha = git(remote, 'rev-parse', 'feature-pr');

	git(seed, 'checkout', '-q', 'main');
	writeFileSync(path.join(seed, 'README.md'), 'line 1\nadvanced on main\nline 3\n');
	git(seed, 'add', 'README.md');
	git(seed, 'commit', '-q', '-m', 'main moves');
	git(seed, 'push', '-q', remote, 'main');
	const baseSha = git(remote, 'rev-parse', 'main');

	const url = 'https://example.test/pull/42';
	pulls.push({
		url,
		number: 42,
		title: 'PR context',
		state: 'open',
		draft: false,
		headBranch: 'feature-pr',
		updatedAt: '2026-10-01T00:00:00Z',
		repo: 'acme/demo',
		author: 'ada',
		trusted: true,
		body: '',
		baseBranch: 'main',
		baseSha,
		headSha,
		commits: [],
	});
	await recordPullRequest({
		url,
		sessionId: session.id,
		repo: 'acme/demo',
		number: 42,
		title: 'PR context',
		head: 'feature-pr',
		base: 'main',
		state: 'open',
	});

	const startsBefore = started.length;
	assert.deepEqual(await pullRequestDiffFiles(session.id, 42, { path: 'README.md' }), {
		oldText: 'line 1\nline 2\nline 3\n',
		newText: 'line 1\nfeature change\nline 3\n',
	});
	assert.deepEqual(await pullRequestDiffFiles(session.id, 42, { path: 'pr-added.txt' }), {
		oldText: null,
		newText: 'from pr\n',
	});
	assert.deepEqual(await pullRequestDiffFiles(session.id, 42, { path: 'old.txt' }), {
		oldText: 'remove me\n',
		newText: null,
	});
	assert.equal(started.length, startsBefore, 'pullRequestDiffFiles never starts a sandbox');
});
