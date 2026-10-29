import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { checkPreviewResponse } from '../src/services/preview-check.ts';
import { fetchForPage, type PageRequest } from '../src/services/page-fetch.ts';

const preview = { port: 43127, url: 'https://task.w.modal.host', listening: true };

test('preview check reports exact URL, status, redirects and framing headers, not page body', async () => {
	let request: PageRequest | undefined;
	const result = await checkPreviewResponse(preview, async (input) => {
		request = input;
		return { status: 200, statusText: 'OK', url: 'https://task.w.modal.host/app', headers: [['Content-Security-Policy', "frame-ancestors 'none'"], ['Set-Cookie', 'secret']], body: new TextEncoder().encode('private page') };
	});
	assert.equal(request?.url, preview.url);
	assert.equal(request?.method, 'GET');
	assert.deepEqual(result, { ...preview, check: 'http', status: 200, finalUrl: 'https://task.w.modal.host/app', headers: [['Content-Security-Policy', "frame-ancestors 'none'"]] });
});

test('preview check reports failures and does not mistake a local TCP listener for reachability', async () => {
	const failure = await checkPreviewResponse(preview, async () => { throw new Error('connection reset'); });
	assert.equal(failure.check, 'failed');
	assert.equal(failure.detail, 'connection reset');
	const blocked = await checkPreviewResponse(preview, async () => ({ status: 403, statusText: 'Forbidden', url: preview.url!, headers: [], body: new TextEncoder().encode('Blocked host') }));
	assert.equal(blocked.check, 'http');
	assert.equal(blocked.status, 403);
	assert.equal(blocked.detail, 'Blocked host');
	const local = await checkPreviewResponse({ ...preview, url: 'http://localhost:43127' }, async () => { throw new Error('must not fetch'); });
	assert.equal(local.check, 'local');
	assert.equal((await checkPreviewResponse({ ...preview, url: null })).check, 'unavailable');
});

test('preview check reads the real HTTP response rather than only the port probe', async (t) => {
	const server = createServer((_req, res) => { res.writeHead(403, { 'x-frame-options': 'DENY' }); res.end('Blocked host'); });
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	const port = (server.address() as AddressInfo).port;
	const result = await checkPreviewResponse({ port, url: `http://127.0.0.1:${port}`, listening: true }, () => { throw new Error('local URLs are not externally checked'); });
	assert.equal(result.check, 'local');
	// Simulate an exposed hostname while directing the check to this test server.
	const external = await checkPreviewResponse({ port, url: 'https://task.w.modal.host', listening: true }, (request) =>
		fetchForPage({ ...request, url: `http://127.0.0.1:${port}` }, { allow: (address) => address === '127.0.0.1' }),
	);
	assert.equal(external.check, 'http');
	if (external.check !== 'http') throw new Error('Expected an HTTP response');
	assert.equal(external.status, 403);
	assert.equal(external.detail, 'Blocked host');
	assert.deepEqual(external.headers, [['x-frame-options', 'DENY']]);
});
