import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { type HistoryMessage, latestTurns, turnsBefore, turnsFrom, turnsParam } from '../src/core/conversation-window.ts';
import { conversationWindow } from '../src/routes/conversation-window.ts';

/** `turns` turns of a message you sent and a reply; turn 3 also has a message that joined its reply. */
function history(turns: number) {
	const messages: HistoryMessage[] = [];
	for (let turn = 0; turn < turns; turn++) {
		messages.push({ id: `u${turn}`, role: 'user', parts: [] });
		messages.push({ id: `a${turn}`, role: 'assistant', parts: [] });
		if (turn === 3) messages.push({ id: 'joined', role: 'user', joined: true, parts: [] }, { id: 'a3b', role: 'assistant', parts: [] });
	}
	return { v: 1, conversationId: 'c', offset: '0000_0042', incarnation: 'inc-1', messages, settlements: messages.filter((m) => m.role === 'user').map((m) => ({ submissionId: m.id, outcome: 'completed' })) };
}
const ids = (messages: HistoryMessage[]) => messages.map((message) => message.id);

test('a window holds the latest turns whole, keeps the rest of the snapshot, and says where the rest begins', () => {
	const full = history(12);
	const window = latestTurns(full, 3);
	assert.deepEqual(ids(window.messages), ['u9', 'a9', 'u10', 'a10', 'u11', 'a11']);
	assert.deepEqual(window.window, { before: 'u9', total: full.messages.length });
	assert.equal(window.offset, full.offset);
	assert.equal(window.incarnation, 'inc-1');
	assert.deepEqual(window.settlements, full.settlements);
});

test('a conversation shorter than the window is sent whole, with nothing before it', () => {
	const full = history(2);
	const window = latestTurns(full, 10);
	assert.deepEqual(window.messages, full.messages);
	assert.equal(window.window.before, null);
});

test('older pages walk back turn by turn, never starting at a message that joined a reply', () => {
	const full = history(6);
	const window = latestTurns(full, 2);
	assert.deepEqual(ids(window.messages), ['u4', 'a4', 'u5', 'a5']);
	const page = turnsBefore(full, window.window.before!, 2)!;
	assert.deepEqual(ids(page.messages), ['u2', 'a2', 'u3', 'a3', 'joined', 'a3b']);
	assert.equal(page.before, 'u2');
	const last = turnsBefore(full, page.before!, 2)!;
	assert.deepEqual(ids(last.messages), ['u0', 'a0', 'u1', 'a1']);
	assert.equal(last.before, null);
	assert.equal(last.incarnation, 'inc-1');
	// Every message once, in order.
	assert.deepEqual([...ids(last.messages), ...ids(page.messages), ...ids(window.messages)], ids(full.messages));
});

test('a conversation read again starts where it started before, or at its latest turns once that message is gone', () => {
	const full = history(12);
	const again = turnsFrom(full, 'u7', 3);
	assert.deepEqual(ids(again.messages), ['u7', 'a7', 'u8', 'a8', 'u9', 'a9', 'u10', 'a10', 'u11', 'a11']);
	assert.deepEqual(again.window, { before: 'u7', total: full.messages.length });
	assert.equal(turnsFrom(full, 'u0', 3).window.before, null);
	assert.deepEqual(ids(turnsFrom(full, 'gone', 3).messages), ids(latestTurns(full, 3).messages));
});

test('a page before a message that is gone is refused', () => {
	assert.equal(turnsBefore(history(4), 'nope', 2), null);
});

test('turns must be a whole number from 1, capped', () => {
	assert.equal(turnsParam(undefined), null);
	assert.equal(turnsParam('0'), null);
	assert.equal(turnsParam('-2'), null);
	assert.equal(turnsParam('2.5'), null);
	assert.equal(turnsParam('abc'), null);
	assert.equal(turnsParam('10'), 10);
	assert.equal(turnsParam('9999'), 50);
});

function server(full: ReturnType<typeof history> | null) {
	const asked: string[] = [];
	const router = { request: (path: string) => (asked.push(path), full ? Response.json(full, { headers: { 'cache-control': 'no-store' } }) : Response.json({ error: 'not found' }, { status: 404 })) };
	const app = new Hono();
	app.route('/', conversationWindow(() => router));
	// What Flue's router answers when the window passes a request on.
	app.get('/api/agents/coder/:id', (c) => c.json({ flue: true }));
	return { app, asked };
}

test('the routes read Flue’s history in-process and pass other reads on', async () => {
	const { app, asked } = server(history(12));
	const window = await app.request('/api/agents/coder/t1?view=history&turns=3');
	assert.equal(window.status, 200);
	assert.equal(window.headers.get('cache-control'), 'no-store');
	assert.equal(((await window.json()) as { messages: unknown[] }).messages.length, 6);
	assert.deepEqual(asked, ['/t1?view=history']);
	const again = await app.request('/api/agents/coder/t1?view=history&turns=3&from=u8');
	assert.deepEqual(ids(((await again.json()) as { messages: HistoryMessage[] }).messages).slice(0, 2), ['u8', 'a8']);

	const older = await app.request('/api/agents/coordinator/space_1/older?before=u9&turns=2');
	assert.deepEqual(ids(((await older.json()) as { messages: HistoryMessage[] }).messages), ['u7', 'a7', 'u8', 'a8']);
	assert.equal((await app.request('/api/agents/coder/t1/older?before=gone')).status, 409);

	assert.deepEqual(await (await app.request('/api/agents/coder/t1?view=history')).json(), { flue: true });
	assert.deepEqual(await (await app.request('/api/agents/coder/t1?view=history&turns=0')).json(), { flue: true });
	assert.equal((await app.request('/api/agents/reviewer/t1?view=history&turns=3')).status, 404);
});

test('a conversation Flue does not have stays a 404', async () => {
	const { app } = server(null);
	assert.equal((await app.request('/api/agents/coder/t1?view=history&turns=3')).status, 404);
	assert.equal((await app.request('/api/agents/coder/t1/older?before=u1')).status, 404);
});
