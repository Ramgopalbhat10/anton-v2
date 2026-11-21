import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { site } from '../src/core/site.ts';

function built() {
	const root = mkdtempSync(join(tmpdir(), 'anton-site-'));
	mkdirSync(join(root, 'assets'));
	writeFileSync(join(root, 'index.html'), '<!doctype html><script src="/assets/app-abc123.js"></script>');
	writeFileSync(join(root, 'assets', 'app-abc123.js'), `console.log(${JSON.stringify('x'.repeat(4000))});`);
	writeFileSync(join(root, 'sw.js'), 'self.addEventListener("push", () => {});');
	return root;
}

const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: `task-${i}`, title: 'A task with a title' })) };

function api(request: Request): Response {
	const path = new URL(request.url).pathname;
	if (path === '/api/events') {
		const body = new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode('data: {}\n\n')) });
		return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
	}
	return Response.json(big);
}

const gzip = { headers: { 'Accept-Encoding': 'gzip' } };

test('hashed assets are cached forever, and the page and other files are checked each load', async () => {
	const app = site(api, built());
	const asset = await app.request('/assets/app-abc123.js');
	assert.equal(asset.status, 200);
	assert.equal(asset.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
	assert.match(asset.headers.get('Content-Type') ?? '', /javascript/);

	for (const path of ['/', '/agents/some-task', '/sw.js']) {
		const page = await app.request(path);
		assert.equal(page.status, 200, path);
		assert.equal(page.headers.get('Cache-Control'), 'no-cache', path);
	}
});

test("an earlier build's missing asset is a 404, not the page under its name", async () => {
	const response = await site(api, built()).request('/assets/app-old999.js');
	assert.equal(response.status, 404);
	assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('API answers and assets are gzipped for a client that accepts it', async () => {
	const app = site(api, built());
	const answer = await app.request('/api/sessions', gzip);
	assert.equal(answer.headers.get('Content-Encoding'), 'gzip');
	assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await answer.arrayBuffer())).toString()), big);

	const asset = await app.request('/assets/app-abc123.js', gzip);
	assert.equal(asset.headers.get('Content-Encoding'), 'gzip');
	assert.equal(asset.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
});

test('server events are never compressed, so each one reaches the page as it is sent', async () => {
	const events = await site(api, built()).request('/api/events', gzip);
	assert.equal(events.headers.get('Content-Encoding'), null);
	const reader = events.body!.getReader();
	const { value } = await reader.read();
	assert.equal(new TextDecoder().decode(value), 'data: {}\n\n');
	await reader.cancel();
});

test('an API read the browser already holds comes back as an empty, uncompressed 304; a changed one is sent gzipped', async () => {
	const app = site(api, built());
	const first = await app.request('/api/sessions', gzip);
	const tag = first.headers.get('ETag')!;
	assert.ok(tag);
	assert.equal(first.headers.get('Content-Encoding'), 'gzip');
	assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await first.arrayBuffer())).toString()), big);

	const again = await app.request('/api/sessions', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': tag } });
	assert.equal(again.status, 304);
	assert.equal(again.headers.get('Content-Encoding'), null);
	assert.equal((await again.arrayBuffer()).byteLength, 0);

	const other = await app.request('/api/sessions', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': 'W/"older"' } });
	assert.equal(other.status, 200);
	assert.equal(other.headers.get('ETag'), tag);
});
