import assert from 'node:assert/strict';
import { createServer, globalAgent, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { after, test } from 'node:test';
import { previewAddress, previewPortOf, previewTemplate, publishPreviewPorts, servePreviews } from '../src/core/preview-proxy.ts';
import { routeUpgrades } from '../src/core/upgrades.ts';

const TEMPLATE = 'https://preview-{port}.example.com';

test('the preview template names a hostname per port, and only its own hosts map to a port', () => {
	assert.equal(previewTemplate(TEMPLATE), TEMPLATE);
	assert.equal(previewTemplate(`${TEMPLATE}/`), TEMPLATE);
	assert.equal(previewTemplate(undefined), null);
	assert.equal(previewTemplate('https://preview.example.com'), null, 'no {port}');
	assert.equal(previewTemplate('https://example.com/preview/{port}'), null, 'a path is not a hostname of its own');
	assert.equal(previewAddress(43127, TEMPLATE), 'https://preview-43127.example.com');
	assert.equal(previewAddress(43127, null), null);
	assert.equal(previewPortOf('preview-43127.example.com', TEMPLATE), 43127);
	assert.equal(previewPortOf('Preview-5173.Example.com:443', TEMPLATE), 5173);
	assert.equal(previewPortOf('anton.example.com', TEMPLATE), null);
	assert.equal(previewPortOf('preview-43127.example.com.evil.test', TEMPLATE), null);
	assert.equal(previewPortOf('preview-x.example.com', TEMPLATE), null);
	assert.equal(previewPortOf('preview-99999.example.com', TEMPLATE), null);
	assert.equal(previewPortOf('preview-43127.example.com', null), null);
});

const listening = (server: Server) =>
	new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
const servers: Server[] = [];
after(() => {
	for (const server of servers) {
		server.closeAllConnections();
		server.close();
	}
	globalAgent.destroy();
});

function get(port: number, host: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path: '/@vite/client?x=1', headers: { host } }, (res) => {
			let body = '';
			res.on('data', (chunk) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
		});
		req.on('error', reject);
		req.end();
	});
}

test('requests and sockets for a preview hostname reach that port on this machine; Anton keeps every other host', async () => {
	// A dev server: answers with what it was asked, and echoes over an upgraded socket like Vite's live reload.
	const dev = createServer((req, res) => res.writeHead(200, { 'x-dev': '1' }).end(`dev ${req.headers.host} ${req.url}`));
	dev.on('upgrade', (_req, socket) => {
		socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
		socket.on('data', (data) => socket.write(`echo:${data}`));
	});
	const devPort = await listening(dev);
	const anton = createServer((_req, res) => res.end('anton'));
	const socketsToAnton: string[] = [];
	servers.push(dev, anton);
	const antonPort = await listening(anton);
	servePreviews(anton, antonPort, TEMPLATE);
	routeUpgrades(anton, '/');
	const { publishUpgradeHandler } = await import('../src/core/upgrades.ts');
	publishUpgradeHandler((req, socket) => {
		socketsToAnton.push(req.headers.host ?? '');
		socket.end('HTTP/1.1 204 No Content\r\n\r\n');
	});
	publishPreviewPorts((port) => port === devPort);

	const proxied = await get(antonPort, `preview-${devPort}.example.com`);
	assert.equal(proxied.status, 200);
	assert.equal(proxied.body, `dev preview-${devPort}.example.com /@vite/client?x=1`, "the browser's Host and path reach the dev server");
	assert.equal(proxied.headers['x-dev'], '1');
	assert.equal((await get(antonPort, 'anton.example.com')).body, 'anton');

	const refused = await get(antonPort, `preview-${devPort + 1}.example.com`);
	assert.equal(refused.status, 404, 'a port no project previews on is not served');
	assert.match(refused.body, /Nothing is being previewed on port/);
	assert.equal((await get(antonPort, `preview-${antonPort}.example.com`)).status, 404, "never Anton's own port");

	const echoed = await new Promise<string>((resolve, reject) => {
		const socket = connect(antonPort, '127.0.0.1', () => {
			socket.write(`GET /?token=1 HTTP/1.1\r\nHost: preview-${devPort}.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
		});
		let seen = '';
		socket.on('data', (data) => {
			seen += data;
			if (seen.includes('\r\n\r\n') && !seen.includes('echo:')) socket.write('ping');
			if (seen.includes('echo:ping')) {
				socket.destroy();
				resolve(seen);
			}
		});
		socket.on('error', reject);
	});
	assert.match(echoed, /^HTTP\/1\.1 101/);
	assert.deepEqual(socketsToAnton, [], "a preview's socket never reaches Anton's own socket routes");
});
