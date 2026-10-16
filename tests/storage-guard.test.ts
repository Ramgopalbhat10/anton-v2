import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createClient } from '@libsql/client';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-guard-'));
process.env.ANTON_DATA_DIR = path.join(dir, 'data');
process.env.ANTON_STORE = 'disk';
process.env.ANTON_SANDBOX = 'local';
after(() => rmSync(dir, { recursive: true, force: true }));

const { useDatabase } = await import('../src/db/client.ts');
const { getProviders } = await import('../src/providers/index.ts');
const { cleanUpStorage } = await import('../src/services/storage.ts');
useDatabase(createClient({ url: `file:${path.join(dir, 'anton.db')}` }));

test('cleanup never removes tasks this database does not know: storage shared with another server, or a database not restored yet', async () => {
	const { store } = getProviders();
	await store.put('sessions/older-task/checkpoint.json', '{"files":[{"path":"a","blob":"blobs/a"}],"log":[]}');
	await store.put('sessions/older-task/outputs/diagram.png', 'png');
	await store.put('blobs/a', 'kept');
	await cleanUpStorage(Date.now() + 2 * 60 * 60_000);
	assert.ok(await store.has('sessions/older-task/checkpoint.json'));
	assert.ok(await store.has('sessions/older-task/outputs/diagram.png'));
	assert.ok(await store.has('blobs/a'), 'what its checkpoint uses stays too');
});
