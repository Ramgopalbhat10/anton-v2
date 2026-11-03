import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-artifact-archive-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const { artifactArchive, MAX_ARCHIVE_BYTES } = await import('../src/services/artifact-archive.ts');
const { listArtifacts } = await import('../src/services/artifacts.ts');
const { saveOutput, savedOutputs } = await import('../src/services/checkpoints.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');
const { writeOutputIndex, outputIndexGeneration } = await import('../src/db/pages.ts');
const { addFile, ADDED_FILES } = await import('../src/services/added-files.ts');
const store = diskStore(path.join(dir, 'objects'));
let oversizedKey: string | undefined;
setProviders({ sandbox: { name: 'none', find: async () => null } as never, store: {
	...store,
	get: async (key) => key === oversizedKey ? new Uint8Array(MAX_ARCHIVE_BYTES + 1) : store.get(key),
}, git: {} as never, models: { name: 'x', list: async () => [] } });
const project = await upsertProject('acme/demo', 'main');
for (const id of ['zip1', 'zip2']) await insertSession({ id, projectId: project.id, title: 'ZIP test', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });
const encode = (value: string) => new TextEncoder().encode(value);

test('one ZIP preserves nested paths, binary bytes, Unicode, and identical filenames across tasks; repeated selections are deduplicated', async () => {
	await saveOutput('zip1', 'reports/café.txt', encode('first'));
	await saveOutput('zip2', 'reports/café.txt', new Uint8Array([0, 255, 137]));
	const one = { sessionId: 'zip1', path: 'reports/café.txt' };
	const two = { sessionId: 'zip2', path: 'reports/café.txt' };
	const entries = unzipSync(await artifactArchive([one, two, one]));
	assert.deepEqual(Object.keys(entries), ['1-zip1/reports/café.txt', '2-zip2/reports/café.txt']);
	assert.equal(strFromU8(entries['1-zip1/reports/café.txt']), 'first');
	assert.deepEqual(entries['2-zip2/reports/café.txt'], new Uint8Array([0, 255, 137]));
});

test('files added by the user are downloadable too, including empty files', async () => {
	const path = await addFile('empty.txt', new Uint8Array());
	const entries = unzipSync(await artifactArchive([{ sessionId: ADDED_FILES, path }]));
	assert.equal(entries[`1-${ADDED_FILES}/empty.txt`].length, 0);
});

test('sanitized extraction names cannot collide or escape the archive root', async () => {
	await saveOutput('zip1', 'a\\b.txt', encode('a'));
	await saveOutput('zip1', 'a:b.txt', encode('b'));
	const entries = unzipSync(await artifactArchive(['a\\b.txt', 'a:b.txt'].map((path) => ({ sessionId: 'zip1', path }))));
	assert.deepEqual(Object.keys(entries), ['1-zip1/a-b.txt', '1-zip1/a-b.txt (1)']);
});

test('empty, excessive, unknown, upload and traversal selections are rejected', async () => {
	await assert.rejects(artifactArchive([]), /between 1 and 500/);
	await assert.rejects(artifactArchive(Array.from({ length: 501 }, () => ({ sessionId: 'zip1', path: 'x' }))), /between 1 and 500/);
	for (const path of ['missing.txt', '../private.txt', '/private.txt', 'uploads/private.txt']) {
		await assert.rejects(artifactArchive([{ sessionId: 'zip1', path }]), /no longer available/);
	}
	await assert.rejects(artifactArchive([{ sessionId: 'unknown', path: 'reports/café.txt' }]), /no longer available/);
});

test('a missing stored file fails the entire download instead of returning a partial archive', async () => {
	await saveOutput('zip1', 'gone.txt', encode('gone'));
	await listArtifacts(); // Cache the listing before the underlying object disappears.
	const saved = (await savedOutputs('zip1')).find((item) => item.path === 'gone.txt')!;
	await store.remove(saved.key!);
	await assert.rejects(artifactArchive([{ sessionId: 'zip1', path: 'reports/café.txt' }, { sessionId: 'zip1', path: 'gone.txt' }]), /File no longer available: gone.txt/);
});

test('the size limit is checked against both indexed sizes and actual bytes', async () => {
	await saveOutput('zip2', 'large.bin', encode('small originally'));
	await writeOutputIndex('zip2', [{ path: 'large.bin', size: MAX_ARCHIVE_BYTES + 1, mtimeMs: Date.now() }], outputIndexGeneration('zip2'));
	await assert.rejects(artifactArchive([{ sessionId: 'zip2', path: 'large.bin' }]), /limited to 50 MB/);
	await writeOutputIndex('zip2', [{ path: 'large.bin', size: 1, mtimeMs: Date.now() }], outputIndexGeneration('zip2'));
	oversizedKey = (await savedOutputs('zip2')).find((item) => item.path === 'large.bin')!.key!;
	await assert.rejects(artifactArchive([{ sessionId: 'zip2', path: 'large.bin' }]), /limited to 50 MB/);
	oversizedKey = undefined;
});
