import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { cloneRepo, gitAuthArgs } from '../src/lib/sandbox.ts';

const execFile = promisify(execFileCb);
const root = mkdtempSync(path.join(tmpdir(), 'anton-clone-'));
const token = 'gho_supersecret_token';

after(() => {
	rmSync(root, { recursive: true, force: true });
});

test('gitAuthArgs puts the token in a request header and not in the URL', () => {
	assert.deepEqual(gitAuthArgs(null), []);
	const args = gitAuthArgs(token);
	assert.equal(args.includes(token) || args.some((arg) => arg.includes(token)), true);
	assert.equal(args.some((arg) => arg.startsWith('https://')), false);
});

test('cloneRepo checks out the repo without storing the token in git config', async () => {
	const source = path.join(root, 'source');
	await execFile('git', ['init', '-b', 'main', source]);
	await execFile('git', ['config', 'user.email', 'source@example.test'], { cwd: source });
	await execFile('git', ['config', 'user.name', 'Source'], { cwd: source });
	writeFileSync(path.join(source, 'README.md'), 'hello\n');
	await execFile('git', ['add', '.'], { cwd: source });
	await execFile('git', ['commit', '-m', 'init'], { cwd: source });

	const projectId = `proj_${path.basename(root)}`;
	const cwd = await cloneRepo({
		projectId,
		cloneUrl: source,
		token,
		defaultBranch: 'main',
		userName: 'Mona Lisa',
		userEmail: 'mona@example.test',
		workspacesRoot: root,
	});

	const remote = (await execFile('git', ['remote', 'get-url', 'origin'], { cwd })).stdout;
	assert.equal(remote.includes(token), false);
	assert.equal(remote.trim(), source);
	const name = (await execFile('git', ['config', 'user.name'], { cwd })).stdout.trim();
	const email = (await execFile('git', ['config', 'user.email'], { cwd })).stdout.trim();
	assert.equal(name, 'Mona Lisa');
	assert.equal(email, 'mona@example.test');
	assert.equal((await execFile('git', ['status', '--porcelain'], { cwd })).stdout, '');

	writeFileSync(path.join(cwd, 'keep.txt'), 'stay\n');
	const again = await cloneRepo({
		projectId,
		cloneUrl: source,
		token,
		defaultBranch: 'main',
		userName: 'Mona Lisa',
		userEmail: 'mona@example.test',
		workspacesRoot: root,
	});
	assert.equal(again, cwd);
	assert.equal((await execFile('git', ['status', '--porcelain'], { cwd })).stdout.includes('keep.txt'), true);
});
