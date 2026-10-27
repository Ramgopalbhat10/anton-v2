import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createClient } from '@libsql/client';
import { waitingMessages } from '../src/services/waiting.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-waiting-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('messages the agent has not read yet are listed in order, and no others', async () => {
	const file = path.join(dir, 'flue.db');
	const flue = createClient({ url: `file:${file}` });
	await flue.execute(
		'CREATE TABLE flue_agent_submissions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL UNIQUE, session_key TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, accepted_at INTEGER NOT NULL, abort_requested_at INTEGER)',
	);
	const key = (agent: string, id: string) => `agent-session:${JSON.stringify([agent, id, 'default', 'default'])}`;
	const add = (id: string, sessionKey: string, body: string, status: string, aborted: number | null = null) =>
		flue.execute({
			sql: 'INSERT INTO flue_agent_submissions (submission_id, session_key, kind, payload, status, accepted_at, abort_requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			args: [id, sessionKey, 'direct', JSON.stringify({ kind: 'direct', message: { kind: 'user', body } }), status, Date.parse('2026-10-27T02:53:50Z'), aborted],
		});
	await add('sub_running', key('Coder', 't1'), 'Can you run the app?', 'running');
	await add('sub_waiting', key('Coder', 't1'), 'Are you stuck?', 'queued');
	await add('sub_next', key('Coder', 't1'), 'And check the ports', 'queued');
	await add('sub_stopped', key('Coder', 't1'), 'Dropped by a Stop', 'queued', Date.now());
	await add('sub_other', key('Coder', 't2'), 'Another task', 'queued');
	await add('sub_review', key('Reviewer', 't1'), 'The reviewer', 'queued');
	flue.close();

	assert.deepEqual(await waitingMessages('t1', file), [
		{ id: 'sub_waiting', text: 'Are you stuck?', at: '2026-10-27T02:53:50.000Z' },
		{ id: 'sub_next', text: 'And check the ports', at: '2026-10-27T02:53:50.000Z' },
	]);
	assert.deepEqual(await waitingMessages('t3', file), []);
	assert.deepEqual(await waitingMessages('t1', path.join(dir, 'missing.db')), []);
});
