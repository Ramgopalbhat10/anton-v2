import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-saved-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { saveOutput, savedOutputs, readOutput } = await import('../src/services/checkpoints.ts');
const { MAX_UPLOAD_BYTES, outputsView, readOutputFile, removeOutput, uploadOutput } = await import('../src/services/files.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');

setProviders({ sandbox: { name: 'none', find: async () => null } as never, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] } });
const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 'ro', projectId: project.id, title: 'Read-only', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });

test('a task without a sandbox keeps outputs saved straight to storage, listed in its Library and readable', async () => {
	const png = new Uint8Array([137, 80, 78, 71]);
	// Saved at once, as parallel steps would: neither entry is lost.
	await Promise.all([saveOutput('ro', 'screenshots/home-1.png', png, 'image/png'), saveOutput('ro', 'screenshots/blog-2.png', png, 'image/png')]);
	assert.deepEqual((await savedOutputs('ro')).map((output) => output.path).sort(), ['screenshots/blog-2.png', 'screenshots/home-1.png']);
	const view = await outputsView('ro');
	assert.equal(view.source, 'base');
	assert.deepEqual(view.outputs.map((output) => [output.path, output.size]).sort(), [['screenshots/blog-2.png', 4], ['screenshots/home-1.png', 4]]);
	assert.deepEqual(await readOutputFile('ro', 'screenshots/home-1.png'), png);
	// Saving the same path again replaces it.
	await saveOutput('ro', 'screenshots/home-1.png', new Uint8Array([1, 2]));
	assert.equal((await savedOutputs('ro')).length, 2);
	assert.deepEqual(await readOutput('ro', 'screenshots/home-1.png'), new Uint8Array([1, 2]));
});

test('a file you add goes under uploads with a safe name, and a deleted one leaves the Library', async () => {
	const path = await uploadOutput('ro', '../../notes?.txt', new TextEncoder().encode('hello'), 'text/plain');
	assert.equal(path, 'uploads/notes_.txt');
	assert.ok((await outputsView('ro')).outputs.some((output) => output.path === path));
	await assert.rejects(uploadOutput('ro', 'big.bin', new Uint8Array(MAX_UPLOAD_BYTES + 1)), /20 MB/);

	await removeOutput('ro', path);
	assert.equal(await readOutputFile('ro', path), null);
	assert.ok(!(await outputsView('ro')).outputs.some((output) => output.path === path));
	await assert.rejects(removeOutput('ro', '../escape'));
});
