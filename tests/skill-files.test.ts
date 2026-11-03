import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { localSandboxProvider } from '../src/providers/local/sandbox.ts';
import { copySkillFiles, copySkillFilesSoon, skillFilesReady, skillsDir } from '../src/services/skill-files.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-skill-files-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test("installed skills' files are copied into the sandbox, and copied again only when they change", async () => {
	const { machine } = await localSandboxProvider(dir).acquire({ key: 'skills', state: null, image: null, baseImage: null, ports: [], resources: { runtime: 'container', cpu: 1, memoryMiB: 1024, idleTimeoutMs: 60_000, lifetimeMs: 60_000, regions: [], allowedDomains: [] } });
	const anatomy = {
		name: 'anatomy',
		description: 'Builds figures.',
		instructions: 'Read references/craft.md.',
		files: { 'references/craft.md': "# Craft\n\nIt's a heredoc's worst case:\nANTON_SKILL_FILE\n", 'kit/logo.bin': new Uint8Array([0, 1, 2, 255]) },
	};
	await copySkillFiles(machine, [anatomy, { name: 'plain', description: 'No files.', instructions: 'Nothing.', files: {} }]);
	const root = skillsDir(machine);
	assert.equal(readFileSync(path.join(root, 'anatomy/references/craft.md'), 'utf8'), anatomy.files['references/craft.md']);
	assert.deepEqual([...readFileSync(path.join(root, 'anatomy/kit/logo.bin'))], [0, 1, 2, 255]);

	// An unchanged copy is left alone; a changed skill replaces it.
	await machine.exec(`touch ${root}/anatomy/scratch`);
	await copySkillFiles(machine, [anatomy]);
	assert.equal((await machine.exec(`test -e ${root}/anatomy/scratch`)).exitCode, 0);
	await copySkillFiles(machine, [{ ...anatomy, files: { 'references/craft.md': 'new' } }]);
	assert.equal(readFileSync(path.join(root, 'anatomy/references/craft.md'), 'utf8'), 'new');
	assert.notEqual((await machine.exec(`test -e ${root}/anatomy/scratch`)).exitCode, 0);
});

test('a sandbox starts without waiting for the copy, and an activated skill waits for it to finish', async () => {
	const { machine } = await localSandboxProvider(dir).acquire({ key: 'soon', state: null, image: null, baseImage: null, ports: [], resources: { runtime: 'container', cpu: 1, memoryMiB: 1024, idleTimeoutMs: 60_000, lifetimeMs: 60_000, regions: [], allowedDomains: [] } });
	const big = { name: 'big', description: 'Many files.', instructions: 'Read them.', files: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`references/${index}.md`, 'x'.repeat(20_000)])) };
	const problems: unknown[] = [];
	copySkillFilesSoon('task-soon', machine, [big], (error) => problems.push(error));
	// Nothing half-written shows meanwhile: the folder appears whole or not at all.
	const during = await machine.exec(`ls ${skillsDir(machine)}/big/references 2>/dev/null | wc -l`);
	const count = (typeof during.stdout === 'string' ? during.stdout : new TextDecoder().decode(during.stdout)).trim();
	assert.ok(['0', '40'].includes(count), `saw ${count} files`);
	await skillFilesReady('task-soon');
	assert.deepEqual(problems, []);
	assert.equal(readFileSync(path.join(skillsDir(machine), 'big/references/39.md'), 'utf8').length, 20_000);
	// A task with no copy running is ready at once.
	await skillFilesReady('no-such-task');
});
