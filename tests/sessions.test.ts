import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createClient } from '@libsql/client';
import { migrateAppDb } from '../src/lib/db-app.ts';
import { createSession, listSessions, runningSandboxCount, stopSession } from '../src/lib/sessions.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-sessions-'));
const dbPath = path.join(dir, 'anton.db');
const db = createClient({ url: `file:${dbPath}` });

before(async () => {
	await migrateAppDb(db);
});

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

test('createSession attaches one sandbox and stop clears it', async () => {
	const session = await createSession({ title: 'First' }, db);
	assert.equal(session.status, 'running');
	assert.ok(session.sandboxId);
	assert.equal(runningSandboxCount(session.projectId), 1);

	const second = await createSession({ title: 'Second' }, db);
	assert.equal(second.projectId, session.projectId);
	assert.equal(second.sandboxId, session.sandboxId);
	assert.equal(runningSandboxCount(session.projectId), 1);

	await stopSession(second.id, db);
	assert.equal(runningSandboxCount(session.projectId), 1);

	const stopped = await stopSession(session.id, db);
	assert.equal(stopped.status, 'stopped');
	assert.equal(stopped.sandboxId, null);
	assert.equal(runningSandboxCount(session.projectId), 0);

	const listed = await listSessions(db);
	assert.ok(listed.length >= 2);
});
