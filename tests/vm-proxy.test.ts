import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { gitStatus, listPaths, readWorkspaceFile } from '../src/lib/vm-proxy.ts';

const execFile = promisify(execFileCb);
const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-git-'));

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

test('gitStatus reports a clean repo with no pushed changes patch', async () => {
	await execFile('git', ['init', '-b', 'main'], { cwd: dir });
	await execFile('git', ['config', 'user.email', 'anton@localhost'], { cwd: dir });
	await execFile('git', ['config', 'user.name', 'Anton'], { cwd: dir });
	writeFileSync(path.join(dir, 'README.md'), '# hi\n');
	await execFile('git', ['add', '.'], { cwd: dir });
	await execFile('git', ['commit', '-m', 'init'], { cwd: dir });

	const clean = await gitStatus(dir);
	assert.equal(clean.branch, 'main');
	assert.equal(clean.patch.trim(), '');

	writeFileSync(path.join(dir, 'README.md'), '# changed\n');
	const dirty = await gitStatus(dir);
	assert.match(dirty.patch, /changed/);

	const paths = await listPaths(dir);
	assert.ok(paths.includes('README.md'));
	assert.equal(await readWorkspaceFile(dir, 'README.md'), '# changed\n');
	await assert.rejects(() => readWorkspaceFile(dir, '../escape.txt'));
});
