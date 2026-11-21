import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { conditionalJson, tagMatches } from '../src/core/conditional.ts';

function app() {
	const app = new Hono();
	app.use('*', conditionalJson());
	let count = 1;
	app.get('/list', (c) => c.json({ count }));
	app.post('/list', (c) => c.json({ count: ++count }));
	app.get('/secret', (c) => c.json({ token: 'x' }, 200, { 'Cache-Control': 'no-store' }));
	app.get('/login', (c) => c.json({ ok: true }, 200, { 'Set-Cookie': 'a=b' }));
	app.get('/text', (c) => c.text('plain'));
	app.get('/missing', (c) => c.json({ error: 'gone' }, 404));
	app.get('/events', (c) => streamSSE(c, async (stream) => void (await stream.writeSSE({ data: 'one' }))));
	return app;
}

test('a JSON read is tagged with its body, and the same tag back gets an empty 304', async () => {
	const server = app();
	const first = await server.request('/list');
	const tag = first.headers.get('etag')!;
	assert.match(tag, /^W\/"[\w-]+"$/);
	assert.equal(first.headers.get('cache-control'), 'private, no-cache');
	assert.deepEqual(await first.json(), { count: 1 });

	const again = await server.request('/list', { headers: { 'If-None-Match': tag } });
	assert.equal(again.status, 304);
	assert.equal(await again.text(), '');
	assert.equal(again.headers.get('etag'), tag);
	// Cloudflare may hand the tag back strong, or with others.
	assert.equal((await server.request('/list', { headers: { 'If-None-Match': `"x", ${tag.slice(2)}` } })).status, 304);
});

test('a changed answer is sent whole, under a new tag', async () => {
	const server = app();
	const tag = (await server.request('/list')).headers.get('etag')!;
	await server.request('/list', { method: 'POST' });
	const changed = await server.request('/list', { headers: { 'If-None-Match': tag } });
	assert.equal(changed.status, 200);
	assert.notEqual(changed.headers.get('etag'), tag);
	assert.deepEqual(await changed.json(), { count: 2 });
});

test('answers that may not be kept, other types, failures, writes and streams pass through untouched', async () => {
	const server = app();
	for (const path of ['/secret', '/login', '/text', '/missing']) assert.equal((await server.request(path)).headers.get('etag'), null, path);
	assert.equal((await server.request('/secret')).headers.get('cache-control'), 'no-store');
	assert.equal((await server.request('/list', { method: 'POST' })).headers.get('etag'), null);
	const events = await server.request('/events');
	assert.equal(events.headers.get('etag'), null);
	assert.match(await events.text(), /data: one/);
});

test('tags match weak or strong, in a list, or as *', () => {
	assert.ok(tagMatches('W/"a"', 'W/"a"'));
	assert.ok(tagMatches('"a"', 'W/"a"'));
	assert.ok(tagMatches('"b", W/"a"', 'W/"a"'));
	assert.ok(tagMatches('*', 'W/"a"'));
	assert.ok(!tagMatches('"b"', 'W/"a"'));
	assert.ok(!tagMatches(undefined, 'W/"a"'));
});
