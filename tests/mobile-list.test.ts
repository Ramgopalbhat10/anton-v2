import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '../src/core/types.ts';
import { LIST_REPLY_CHARS, listRow } from '../src/routes/mobile.ts';

const session = (patch: Partial<Session>) => ({ id: 't1', title: 'Task', status: 'idle', working: false, createdAt: '2026-01-01T00:00:00.000Z', ...patch }) as Session;

test('the app task list leaves out the plan and sends only the start of a long last reply', () => {
	const long = 'line\n'.repeat(1_000);
	const row = listRow(session({ plan: '# Plan\n'.repeat(500), lastReply: long, asking: 'Which branch?' }));
	assert.equal('plan' in row, false);
	assert.equal(row.lastReply, long.slice(0, LIST_REPLY_CHARS));
	assert.equal(row.asking, 'Which branch?');
	assert.equal(row.title, 'Task');
});

test('a short or missing last reply is sent as it is', () => {
	assert.equal(listRow(session({ lastReply: 'Done.' })).lastReply, 'Done.');
	assert.equal(listRow(session({ lastReply: null as never })).lastReply, null);
});
