import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBusy, whenFree } from '../src/db/client.ts';

const locked = () => Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });

test('a statement that meets another writer’s lock waits for it, then runs', async () => {
	let tries = 0;
	const result = await whenFree(async () => {
		tries += 1;
		if (tries < 3) throw locked();
		return 'done';
	});
	assert.equal(result, 'done');
	assert.equal(tries, 3);
});

test('a lock held past the wait fails as before, and other errors are never retried', async () => {
	await assert.rejects(whenFree(async () => { throw locked(); }, 50), /database is locked/);
	let tries = 0;
	await assert.rejects(whenFree(async () => { tries += 1; throw new Error('no such table: nope'); }), /no such table/);
	assert.equal(tries, 1);
	assert.equal(isBusy(Object.assign(new Error('x'), { code: 'SQLITE_BUSY_SNAPSHOT' })), true);
	assert.equal(isBusy(new Error('UNIQUE constraint failed')), false);
});

test('a write waits out another connection’s transaction on the same file', async () => {
	const { createClient } = await import('@libsql/client');
	const { mkdtempSync, rmSync } = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-db-busy-'));
	const url = `file:${path.join(dir, 'busy.db')}`;
	const holder = createClient({ url });
	const writer = createClient({ url });
	try {
		await holder.execute('PRAGMA journal_mode = WAL');
		await holder.execute('CREATE TABLE t (x)');
		const tx = await holder.transaction('write');
		await tx.execute('INSERT INTO t VALUES (0)');
		await assert.rejects(writer.execute('INSERT INTO t VALUES (1)'), (error: unknown) => isBusy(error));
		setTimeout(() => void tx.commit(), 100);
		await whenFree(() => writer.execute('INSERT INTO t VALUES (1)'));
		assert.equal((await writer.execute('SELECT count(*) AS n FROM t')).rows[0].n, 2);
	} finally {
		holder.close();
		writer.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
