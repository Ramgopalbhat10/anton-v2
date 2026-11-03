import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-traces-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { getTrace, saveTrace } = await import('../src/db/traces.ts');
const { appDb } = await import('../src/db/client.ts');

const trace = (id: string, sessionId = 's') => ({ id, sessionId, startedAt: new Date().toISOString(), durationMs: 10, model: 'x', spans: [], prompts: {}, toolsets: {}, dropped: 0 }) as unknown as Parameters<typeof saveTrace>[0];

test('a trace whose save failed still opens from memory, and a kept one from the database', async () => {
	const db = await appDb();
	await db.execute('ALTER TABLE response_traces RENAME TO response_traces_away');
	await assert.rejects(saveTrace(trace('lost')));
	await db.execute('ALTER TABLE response_traces_away RENAME TO response_traces');
	assert.equal((await getTrace('s', 'lost'))?.id, 'lost');
	assert.equal(await getTrace('other', 'lost'), null, 'only for its own task');
	await saveTrace(trace('kept'));
	const row = await db.execute({ sql: 'SELECT id FROM response_traces WHERE id = ?', args: ['kept'] });
	assert.equal(row.rows.length, 1);
	for (let i = 0; i < 60; i += 1) await saveTrace(trace(`t${i}`, 'busy'));
	assert.equal((await getTrace('s', 'kept'))?.id, 'kept', 'read back from the database once memory has moved on');
	assert.equal(await getTrace('s', 'lost'), null, 'memory keeps only the latest');
});
