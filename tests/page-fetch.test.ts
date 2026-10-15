import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-page-fetch-'));
process.env.ANTON_DATA_DIR = dir;

const { fetchForPage, isPublicAddress, pageFetch } = await import('../src/services/page-fetch.ts');
const { injectBootstrap, pageGuide, renderFrame } = await import('../src/services/renders.ts');
const { generalSettings, setGeneralSettings } = await import('../src/services/general.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');

setProviders({ sandbox: { name: 'none', find: async () => null } as never, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] } });
const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 'f1', projectId: project.id, title: 'Pages', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });

/** What the test server saw of the last request. */
let seen: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string } = { headers: {}, body: '' };

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
	const here = `http://127.0.0.1:${port}`;
	switch (req.url) {
		case '/quote':
			res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'id=1', 'x-rate': '7' });
			res.end(gzipSync(JSON.stringify({ symbol: 'NIFTY', price: 25000 })));
			return;
		case '/moved':
			res.writeHead(302, { location: '/quote' });
			res.end();
			return;
		case '/post-then-see-other':
			res.writeHead(303, { location: '/echo' });
			res.end();
			return;
		case '/elsewhere':
			res.writeHead(307, { location: `http://localhost:${port}/echo` });
			res.end();
			return;
		case '/inside':
			res.writeHead(302, { location: `http://[::1]:${port}/echo` });
			res.end();
			return;
		case '/big':
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('x'.repeat(2048));
			return;
		case '/loop':
			res.writeHead(302, { location: `${here}/loop` });
			res.end();
			return;
		default:
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('echo');
	}
});
let port = 0;
before(async () => {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;
});
after(() => {
	server.close();
	rmSync(dir, { recursive: true, force: true });
});

const local = { allow: (address: string) => address === '127.0.0.1' || address === '::1' };
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test('only addresses on the public internet count as public', () => {
	for (const address of ['8.8.8.8', '104.16.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(address), true, address);
	for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.100.1.1', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '64:ff9b::7f00:1', 'localhost', ''])
		assert.equal(isPublicAddress(address), false, address);
});

test("a page's request is made for it: decoded, without cookies either way, and with the page's own headers", async () => {
	const response = await fetchForPage(
		{ url: `http://127.0.0.1:${port}/quote`, method: 'GET', headers: [['Accept', 'application/json'], ['Cookie', 'secret=1'], ['Origin', 'null'], ['X-Api-Key', 'k']], body: null },
		local,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(JSON.parse(text(response.body)), { symbol: 'NIFTY', price: 25000 });
	const names = response.headers.map(([name]) => name.toLowerCase());
	assert.ok(names.includes('x-rate') && !names.includes('set-cookie') && !names.includes('content-encoding'));
	assert.equal(seen.headers.cookie, undefined);
	assert.equal(seen.headers.origin, undefined);
	assert.equal(seen.headers['x-api-key'], 'k');
	assert.equal(seen.headers.accept, 'application/json');
	assert.match(String(seen.headers['user-agent']), /Anton/);
});

test('redirects are followed as a browser would, and credentials stay with their own site', async () => {
	const moved = await fetchForPage({ url: `http://127.0.0.1:${port}/moved`, method: 'GET', headers: [], body: null }, local);
	assert.equal(moved.url, `http://127.0.0.1:${port}/quote`);
	const posted = await fetchForPage({ url: `http://127.0.0.1:${port}/post-then-see-other`, method: 'POST', headers: [['content-type', 'text/plain']], body: new TextEncoder().encode('hi') }, local);
	assert.equal(text(posted.body), 'echo');
	assert.deepEqual([seen.method, seen.body, seen.headers['content-type']], ['GET', '', undefined]);
	await fetchForPage({ url: `http://127.0.0.1:${port}/elsewhere`, method: 'GET', headers: [['Authorization', 'Bearer t']], body: null }, local);
	assert.equal(seen.headers.authorization, undefined);
	await assert.rejects(fetchForPage({ url: `http://127.0.0.1:${port}/loop`, method: 'GET', headers: [], body: null }, local), /redirected more than 5 times/);
});

test('this machine and its network are out of reach, by name, by address and by redirect', async () => {
	await assert.rejects(fetchForPage({ url: `http://127.0.0.1:${port}/quote`, method: 'GET', headers: [], body: null }), /not on the public internet/);
	await assert.rejects(fetchForPage({ url: `http://localhost:${port}/quote`, method: 'GET', headers: [], body: null }), /not on the public internet/);
	await assert.rejects(fetchForPage({ url: 'http://169.254.169.254/latest/meta-data/', method: 'GET', headers: [], body: null }), /not on the public internet/);
	await assert.rejects(
		fetchForPage({ url: `http://127.0.0.1:${port}/inside`, method: 'GET', headers: [], body: null }, { allow: (address) => address === '127.0.0.1' }),
		/::1 is not on the public internet/,
	);
	await assert.rejects(fetchForPage({ url: 'file:///etc/passwd', method: 'GET', headers: [], body: null }), /http and https addresses only/);
	await assert.rejects(fetchForPage({ url: `http://127.0.0.1:${port}/big`, method: 'GET', headers: [], body: null }, { ...local, maxBytes: 1024 }), /larger than/);
});

test('a page reaches the web only from a task, with the setting on, and with a request that holds together', async () => {
	await assert.rejects(pageFetch('f1', 'notes.txt', { url: 'https://example.com' }), /Not a page/);
	await assert.rejects(pageFetch('nobody', 'renders/a.html', { url: 'https://example.com' }), /Session not found/);
	await assert.rejects(pageFetch('f1', 'renders/a.html', { url: 'https://example.com', method: 'CONNECT' }), /can't send CONNECT/);
	await assert.rejects(pageFetch('f1', 'renders/a.html', { url: 'https://example.com', method: 'GET', body: 'aGk=' }), /has no body/);
	await assert.rejects(pageFetch('f1', 'renders/a.html', { url: 'https://example.com', headers: [['bad name', 'x']] }), /name and a value/);
	await assert.rejects(pageFetch('f1', 'renders/a.html', { url: `http://127.0.0.1:${port}/quote` }), (error: Error & { status?: number }) => error.status === 403);
	await setGeneralSettings({ ...(await generalSettings()), pageNetwork: false });
	await assert.rejects(pageFetch('f1', 'renders/a.html', { url: 'https://example.com' }), (error: Error & { status?: number }) => error.status === 403 && /off/.test(error.message));
	await setGeneralSettings({ ...(await generalSettings()), pageNetwork: true });
});

test("the page's fetch goes to its frame page, which has Anton make the request, and the agent is told it can call APIs", () => {
	const page = injectBootstrap('<html><head></head><body></body></html>');
	assert.match(page, /window\.fetch=function/);
	assert.match(page, /post\("anton\/fetch"/);
	const { html } = renderFrame('f1', 'renders/chart-ab12cd.html');
	assert.match(html, /\/page-fetch\?path=/);
	assert.match(html, /d\.method==="anton\/fetch"/);
	assert.match(pageGuide(true), /call web APIs with fetch\(\)/);
	assert.match(pageGuide(false), /It has no network/);
});
