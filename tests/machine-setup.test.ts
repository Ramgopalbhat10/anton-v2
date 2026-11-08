import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { GitHost } from '../src/core/ports.ts';
import type { Project } from '../src/core/types.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-setup-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const { setProviders } = await import('../src/providers/index.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { INSTALLED, readMarker, setUpMachine } = await import('../src/services/machine-setup.ts');

const local = localSandboxProvider(dir);
setProviders({ sandbox: local, git: { gitAuthEnv: () => ({}), cloneUrl: () => '' } as unknown as GitHost } as never);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const project = (setupScript: string) => ({ repoFullName: 'acme/demo', setupScript }) as Project;

test('setup installs packages only when the dependency files changed, and runs the setup script each time', async () => {
	const { machine } = await local.acquire({ key: 'deps', state: null, image: null, baseImage: null, ports: [], resources: {} as never });
	const repo = path.join(machine.root, 'repo');
	execFileSync('git', ['init', '-q', '-b', 'main', repo]);
	git(repo, 'config', 'user.email', 'test@example.com');
	git(repo, 'config', 'user.name', 'Test');
	// An install runs the package's own postinstall, which counts the installs.
	const manifest = (version: string) => JSON.stringify({ name: 'demo', version, private: true, scripts: { postinstall: 'echo installed >> ../installs.log' } });
	writeFileSync(path.join(repo, 'package.json'), manifest('1.0.0'));
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'init');
	const first = git(repo, 'rev-parse', 'HEAD');
	const lines = (file: string) => readFileSync(path.join(machine.root, file), 'utf8').trim().split('\n').length;
	const setup = project('echo ran >> ../setups.log');

	assert.equal(await setUpMachine(machine, setup, { marker: 'task-1', branch: 'anton/one', sha: first }, 'image'), true, 'the first setup installs');
	assert.equal(lines('installs.log'), 1);
	assert.equal(await readMarker(machine), 'task-1');
	assert.equal(git(repo, 'branch', '--show-current'), 'anton/one');

	assert.equal(await setUpMachine(machine, setup, { marker: 'task-2', branch: 'anton/two', sha: first }, 'image'), false, 'unchanged files skip the install');
	assert.equal(lines('installs.log'), 1);
	assert.equal(lines('setups.log'), 2, 'the setup script runs again');
	assert.equal(await readMarker(machine), 'task-2');

	writeFileSync(path.join(repo, 'package.json'), manifest('1.1.0'));
	git(repo, 'commit', '-q', '-am', 'bump');
	const second = git(repo, 'rev-parse', 'HEAD');
	assert.equal(await setUpMachine(machine, setup, { marker: 'task-3', branch: 'anton/three', sha: second }, 'image'), true, 'a changed manifest installs');
	assert.equal(lines('installs.log'), 2);
	assert.ok(INSTALLED.length > 0);

	// A failing setup script fails the setup, names what it printed, and leaves no marker.
	await assert.rejects(() => setUpMachine(machine, project('echo broken >&2; exit 3'), { marker: 'task-4', branch: 'anton/four', sha: second }, 'image'), /broken/);
	assert.equal(await readMarker(machine), null);
});
