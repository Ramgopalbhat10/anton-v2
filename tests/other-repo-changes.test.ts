import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Machine } from '../src/core/ports.ts';
import { otherRepoChanges } from '../src/services/git.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-other-repos-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const machine = {
	id: 'm',
	root: path.join(dir, 'root'),
	exec: async (command: string, options?: { cwd?: string }) => {
		const result = spawnSync('bash', ['-lc', command], { cwd: options?.cwd, encoding: 'buffer' });
		return { stdout: new Uint8Array(result.stdout), stderr: result.stderr.toString(), exitCode: result.status ?? 1 };
	},
} as unknown as Machine;

const git = (cwd: string, args: string, date = '2020-01-01T00:00:00Z') =>
	execSync(`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`, { cwd, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });

test("a chat's change is what it did in repositories outside its scratch folder, since it began", async () => {
	const app = path.join(dir, 'app');
	mkdirSync(app);
	git(app, 'init -q');
	writeFileSync(path.join(app, 'old.ts'), 'export const old = 1;\n');
	git(app, 'add -A');
	git(app, 'commit -q -m before');
	// The scratch folder is left out: its files are the chat's deliverables.
	mkdirSync(path.join(machine.root, 'repo'), { recursive: true });
	git(path.join(machine.root, 'repo'), 'init -q');
	writeFileSync(path.join(machine.root, 'repo', 'report.md'), '# Report\n');
	const since = new Date('2024-01-01T00:00:00Z');
	assert.equal(await otherRepoChanges(machine, since, dir), '', 'nothing changed yet');
	// A commit since the chat began and a new file not yet added both count; the history before does not.
	writeFileSync(path.join(app, 'old.ts'), 'export const old = 2;\n');
	git(app, 'commit -q -am during', '2025-01-01T00:00:00Z');
	writeFileSync(path.join(app, 'new.ts'), 'export const added = true;\n');
	const patch = await otherRepoChanges(machine, since, dir);
	assert.match(patch, new RegExp(`diff --git a${app}/old.ts b${app}/old.ts`));
	assert.match(patch, /\+export const old = 2;/);
	assert.match(patch, /\+export const added = true;/);
	assert.doesNotMatch(patch, /Report/);
	// The agent's own index is untouched: the new file is still untracked.
	assert.match(execSync('git status --porcelain', { cwd: app }).toString(), /\?\? new\.ts/);
});
