import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { zipStream } from '../src/core/zip.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-artifact-download-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { downloadArtifacts } = await import('../src/services/artifact-download.ts');
const { saveOutput } = await import('../src/services/checkpoints.ts');
const { addFile, ADDED_FILES } = await import('../src/services/added-files.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { insertSession } = await import('../src/db/sessions.ts');

setProviders({ sandbox: { name: 'none', find: async () => null } as never, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] } });
for (const id of ['one', 'two']) {
	await insertSession({ id, projectId: null, title: id, model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });
}

/** Decode central-directory entries independently of the ZIP writer. */
function entries(bytes: Buffer): Map<string, Buffer> {
	const end = bytes.length - 22;
	assert.equal(bytes.readUInt32LE(end), 0x06054b50);
	let offset = bytes.readUInt32LE(end + 16);
	const result = new Map<string, Buffer>();
	for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
		assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
		const size = bytes.readUInt32LE(offset + 20);
		const nameLength = bytes.readUInt16LE(offset + 28);
		const local = bytes.readUInt32LE(offset + 42);
		const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
		const data = bytes.subarray(start, start + size);
		result.set(bytes.toString('utf8', offset + 46, offset + 46 + nameLength), bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(data) : data);
		offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
	}
	return result;
}

test('exports selected artifacts, including added files, once and preserves colliding names in numbered folders', async () => {
	await saveOutput('one', 'reports/café.txt', Buffer.from('first'));
	await saveOutput('two', 'reports/café.txt', Buffer.from('second'));
	await saveOutput('one', 'unselected.txt', Buffer.from('not selected'));
	const added = await addFile('binary.png', new Uint8Array([0, 1, 255]), 'image/png');
	const selected = [{ sessionId: 'one', path: 'reports/café.txt' }, { sessionId: 'two', path: 'reports/café.txt' }, { sessionId: ADDED_FILES, path: added }];
	const archive = entries(Buffer.from(await new Response(await downloadArtifacts([...selected, selected[0]])).arrayBuffer()));
	assert.deepEqual([...archive.keys()], ['1/reports/café.txt', '2/reports/café.txt', '3/binary.png']);
	assert.equal(archive.get('1/reports/café.txt')?.toString(), 'first');
	assert.equal(archive.get('2/reports/café.txt')?.toString(), 'second');
	assert.deepEqual(archive.get('3/binary.png'), Buffer.from([0, 1, 255]));
});

test('rejects empty, malformed, oversized, missing, and non-gallery selections before starting a download', async () => {
	for (const value of [null, [], [{}], [{ sessionId: 'one', path: '' }], Array.from({ length: 1001 }, () => ({ sessionId: 'one', path: 'x' }))]) {
		await assert.rejects(downloadArtifacts(value), /Select between/);
	}
	await saveOutput('one', 'uploads/private.txt', Buffer.from('attachment'));
	for (const item of [{ sessionId: 'missing', path: 'x' }, { sessionId: 'one', path: '../escape' }, { sessionId: 'one', path: 'uploads/private.txt' }]) {
		await assert.rejects(downloadArtifacts([item]), /no longer available/);
	}
});

test('makes paths in the ZIP portable without changing the path used to read the artifact', async () => {
	await saveOutput('one', 'reports/c:\\bad?.txt', Buffer.from('safe'));
	const archive = entries(Buffer.from(await new Response(await downloadArtifacts([{ sessionId: 'one', path: 'reports/c:\\bad?.txt' }])).arrayBuffer()));
	assert.deepEqual([...archive.keys()], ['1/reports/c__bad_.txt']);
});

test('a storage failure errors the stream rather than silently omitting an artifact', async () => {
	const stream = zipStream([{ name: 'x.txt', read: async () => { throw new Error('Storage unavailable'); } }]);
	await assert.rejects(async () => { for await (const _chunk of stream) { /* drain */ } }, /Storage unavailable/);
});

test('cancelling a download prevents reading subsequent artifacts', async () => {
	let release: (value: Uint8Array) => void = () => {};
	let laterReads = 0;
	const stream = zipStream([
		{ name: 'first', read: () => new Promise<Uint8Array>((resolve) => { release = resolve; }) },
		{ name: 'later', read: async () => { laterReads++; return new Uint8Array(); } },
	]);
	stream.destroy();
	await new Promise<void>((resolve) => stream.once('close', resolve));
	release(Buffer.from('first'));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(laterReads, 0);
});
