import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const clientUrl = new URL('../src/db/client.ts', import.meta.url).href;

for (const kind of ['default', 'relative', 'encoded', 'encoded-separators', 'encoded-relative-separators', 'backslash', 'query', 'memory', 'plain-memory', 'encoded-memory'] as const) {
	test(`database starts and migrates with ${kind} storage on a fresh installation`, { skip: kind === 'backslash' && process.platform === 'win32' }, () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-db-startup-'));
		const dataDir = path.join(dir, 'missing', 'data');
		const memory = kind.includes('memory');
		const databaseFile = kind === 'default' ? path.join(dataDir, 'anton.db') : path.join(dir, kind === 'backslash' ? 'custom\\folder' : 'custom folder', 'nested', 'anton.db');
		const databaseUrl = {
			default: '',
			relative: `file:./${path.relative(dir, databaseFile)}`,
			encoded: pathToFileURL(databaseFile).href,
			'encoded-separators': `file:${encodeURIComponent(databaseFile)}`,
			'encoded-relative-separators': `file:${encodeURIComponent(path.relative(dir, databaseFile))}`,
			backslash: `file:${databaseFile}`,
			query: `${pathToFileURL(databaseFile).href}?tls=1`,
			memory: 'file::memory:',
			'plain-memory': ':memory:',
			'encoded-memory': 'file:%3Amemory%3A?cache=shared',
		}[kind];
		try {
			assert.equal(existsSync(dataDir), false);
			execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
				import assert from 'node:assert/strict';
				const { appDb } = await import(${JSON.stringify(clientUrl)});
				const [db, same] = await Promise.all([appDb(), appDb()]);
				assert.equal(db, same);
				await db.execute('SELECT id FROM sessions');
				assert.ok((await db.execute('SELECT version FROM schema_migrations')).rows.length > 0);
				assert.equal((await db.execute('PRAGMA database_list')).rows[0].file, ${JSON.stringify(memory ? '' : databaseFile)});
				db.close();
			`], {
				cwd: dir,
				env: { ...process.env, ANTON_DATA_DIR: dataDir, TURSO_DATABASE_URL: databaseUrl, TURSO_AUTH_TOKEN: '' },
				stdio: 'pipe',
			});
			assert.equal(existsSync(databaseFile), !memory);
			if (memory) assert.deepEqual(readdirSync(dir), [], 'memory URLs create no files or directories');
			if (kind === 'backslash') assert.equal(existsSync(path.join(dir, 'custom', 'folder')), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
