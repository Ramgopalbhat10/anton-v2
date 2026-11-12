import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-repo-check-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { upsertProject, getProject } = await import('../src/db/projects.ts');
const { MAX_CHECK_COMMAND, updateSettings } = await import('../src/services/projects.ts');

test('a repository’s check command is empty until set, saved trimmed, kept when a save leaves it out, and refused when too long', async () => {
	const project = await upsertProject('acme/checked', 'main');
	assert.equal(project.checkCommand, '');
	const saved = await updateSettings(project.id, { env: {}, setupScript: 'npm ci', checkCommand: '  npm run check:types\n', previewPorts: [], baseImage: null });
	assert.equal(saved.checkCommand, 'npm run check:types');
	assert.equal((await getProject(project.id))?.checkCommand, 'npm run check:types');
	assert.equal((await getProject(project.id))?.setupScript, 'npm ci');
	await updateSettings(project.id, { env: {}, setupScript: '', previewPorts: [], baseImage: null });
	assert.equal((await getProject(project.id))?.checkCommand, 'npm run check:types', 'left out, it is kept');
	await assert.rejects(updateSettings(project.id, { env: {}, setupScript: '', checkCommand: 'x'.repeat(MAX_CHECK_COMMAND + 1), previewPorts: [], baseImage: null }), /check command/);
	assert.equal((await getProject(project.id))?.checkCommand, 'npm run check:types');
	await updateSettings(project.id, { env: {}, setupScript: '', checkCommand: '', previewPorts: [], baseImage: null });
	assert.equal((await getProject(project.id))?.checkCommand, '', 'cleared, it runs none');
});
