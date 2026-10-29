import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { checkPreviewResponse } from '../src/services/preview-check.ts';
import { fetchForPage } from '../src/services/page-fetch.ts';

test('Preview reports HTTP headers for large and streaming responses and keeps a bounded error prefix', async (t) => {
	const server = createServer((req, res) => {
		if (req.url === '/large') {
			res.writeHead(200, { 'content-security-policy': "frame-ancestors 'none'" });
			res.end('x'.repeat(2 * 1024 * 1024));
		} else if (req.url === '/stream') {
			res.writeHead(200, { 'x-frame-options': 'DENY' });
			res.flushHeaders(); // Never ends or sends a body.
		} else if (req.url === '/redirect') {
			res.writeHead(302, { location: '/stream' });
			res.flushHeaders(); // A redirect body that never ends must not hold the check open.
		} else if (req.url === '/error-stream') {
			res.writeHead(403, { 'content-type': 'text/plain' });
			res.write('Blocked host'); // Never ends.
		} else if (req.url === '/error-stalled') {
			res.writeHead(503);
			res.flushHeaders();
		} else if (req.url === '/error-large') {
			res.writeHead(403);
			res.end('x'.repeat(100_000));
		} else {
			res.writeHead(403, { 'content-encoding': 'gzip' });
			res.end(gzipSync('Blocked compressed host'));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const port = (server.address() as AddressInfo).port;
	const check = (path: string) => checkPreviewResponse({ port, url: `https://preview.example${path}`, listening: true }, (request) =>
		fetchForPage({ ...request, url: `http://127.0.0.1:${port}${path}` }, { allow: (address) => address === '127.0.0.1', responseMode: 'preview', timeoutMs: 2000 }),
	);
	for (const path of ['/large', '/stream', '/redirect']) {
		const result = await check(path);
		assert.equal(result.check, 'http', path);
		if (result.check !== 'http') throw new Error('Expected HTTP response');
		assert.equal(result.status, 200);
		assert.ok(result.headers.length);
	}
	for (const [path, expected] of [['/error-stream', 'Blocked host'], ['/error-stalled', ''], ['/error-large', 'x'.repeat(1500)], ['/gzip', 'Blocked compressed host']] as const) {
		const result = await check(path);
		assert.equal(result.check, 'http', path);
		if (result.check !== 'http') throw new Error('Expected HTTP response');
		assert.equal(result.status, path === '/error-stalled' ? 503 : 403);
		assert.equal(result.detail, expected);
	}
});
