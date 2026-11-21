import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROW_TEXT_CHARS, taskRows, WHOLE_REPLY_THREADS } from '../src/core/task-rows.ts';
import type { Session } from '../src/core/types.ts';

const long = (word: string) => `${word} `.repeat(600);
const task = (patch: Partial<Session>): Session =>
	({ id: 't', projectId: 'p', repo: 'a/b', title: 'T', spaceId: null, lastReply: null, lastInput: null, brief: null, plan: null, asking: null, ...patch }) as Session;

test('a row cuts long texts to a row’s length and names them', () => {
	const [row] = taskRows([task({ lastReply: long('reply'), lastInput: long('input'), brief: long('brief'), plan: long('plan'), asking: long('asking') })]);
	assert.equal(row.lastReply!.length, ROW_TEXT_CHARS.lastReply);
	assert.equal(row.lastInput!.length, ROW_TEXT_CHARS.lastInput);
	assert.equal(row.brief!.length, ROW_TEXT_CHARS.brief);
	assert.equal(row.plan!.length, ROW_TEXT_CHARS.plan);
	assert.ok(long('reply').startsWith(row.lastReply!));
	// A question is shown and notified whole.
	assert.equal(row.asking, long('asking'));
	assert.deepEqual(row.cut, ['lastReply', 'lastInput', 'brief', 'plan']);
});

test('a row with short texts is the task as it is', () => {
	const session = task({ lastReply: 'Done.', plan: '1. Fix it', brief: null });
	const [row] = taskRows([session]);
	assert.deepEqual(row, session);
	assert.equal('cut' in row, false);
});

test('a project’s newest threads keep their last reply whole, for copied file links', () => {
	const threads = Array.from({ length: WHOLE_REPLY_THREADS + 2 }, (_, i) => task({ id: `t${i}`, spaceId: 's1', lastReply: long('reply') }));
	const other = task({ id: 'other', spaceId: 's2', lastReply: long('reply') });
	const chat = task({ id: 'chat', lastReply: long('reply') });
	const rows = taskRows([...threads, other, chat]);
	assert.ok(rows.slice(0, WHOLE_REPLY_THREADS).every((row) => row.lastReply === long('reply') && !row.cut));
	assert.deepEqual(rows[WHOLE_REPLY_THREADS].cut, ['lastReply']);
	assert.equal(rows.find((row) => row.id === 'other')!.lastReply, long('reply'));
	assert.deepEqual(rows.find((row) => row.id === 'chat')!.cut, ['lastReply']);
});

test('a cut never splits a character in two', () => {
	const chars = ROW_TEXT_CHARS.lastInput;
	const text = `${'a'.repeat(chars - 1)}😀 and more`;
	const [row] = taskRows([task({ lastInput: text })]);
	assert.equal(row.lastInput, 'a'.repeat(chars - 1));
});

test('rows leave the tasks they were made from untouched', () => {
	const session = task({ lastReply: long('reply') });
	taskRows([session]);
	assert.equal(session.lastReply, long('reply'));
});
