import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { localSandboxProvider } from '../src/providers/local/sandbox.ts';
import { copySkillFiles, skillsDir } from '../src/services/skill-files.ts';

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
