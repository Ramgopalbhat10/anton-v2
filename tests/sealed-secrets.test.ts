import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-sealed-'));
process.env.ANTON_DATA_DIR = dir;
delete process.env.ANTON_SECRETS_KEY;

const sealed = await import('../src/services/sealed-secrets.ts');
const { httpRequest } = await import('../src/services/http-request.ts');
const { closeEgressConnections, egressFetch, proxyLabel, proxyParts } = await import('../src/services/egress.ts');
const { totp, base32Bytes } = await import('../src/core/totp.ts');
const { getSetting } = await import('../src/db/settings.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { readOutput } = await import('../src/services/checkpoints.ts');
setProviders({ sandbox: { name: 'none', find: async () => null, running: async () => new Set() } as never, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] } });

after(() => {
	closeEgressConnections();
	rmSync(dir, { recursive: true, force: true });
});

/** A self-signed certificate for localhost, or null where openssl is missing. */
function certificate(): { key: string; cert: string } | null {
	const out = mkdtempSync(path.join(os.tmpdir(), 'anton-cert-'));
	try {
		execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(out, 'key.pem'), '-out', path.join(out, 'cert.pem')], { stdio: 'ignore' });
		return { key: readFileSync(path.join(out, 'key.pem'), 'utf8'), cert: readFileSync(path.join(out, 'cert.pem'), 'utf8') };
	} catch {
		return null;
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

const listen = (server: net.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

test('TOTP codes match RFC 6238', () => {
	// RFC 6238's SHA-1 key is the ASCII "12345678901234567890"; these are its 8-digit vectors.
	const key = Buffer.from('12345678901234567890');
	assert.equal(totp(key, 59_000, { digits: 8 }), '94287082');
	assert.equal(totp(key, 1_111_111_109_000, { digits: 8 }), '07081804');
	assert.equal(totp(key, 2_000_000_000_000, { digits: 8 }), '69279037');
	assert.deepEqual(base32Bytes('jbsw y3dp'), base32Bytes('JBSWY3DP'));
	assert.throws(() => base32Bytes('not base32!'), /base32/);
});

test('a sealed secret is stored encrypted and never shown', async () => {
	const view = await sealed.saveSealedSecret({ name: 'DEMO_KEY', value: 'demo-value-123', hosts: ['API.Example.com', '*.example.org'], proxy: 'https://anton:pa55@1-2-3-4.sslip.io' });
	assert.deepEqual(view.map((secret) => [secret.name, secret.hosts, secret.proxy, secret.source.by]), [['DEMO_KEY', ['api.example.com', '*.example.org'], 'https://1-2-3-4.sslip.io', 'you']]);
	const raw = JSON.stringify(await getSetting('sealed-secrets', {}));
	assert.ok(!raw.includes('demo-value-123') && !raw.includes('pa55'), 'neither the value nor the proxy password is stored in the clear');
	assert.ok(!JSON.stringify(view).includes('demo-value-123'));
	// Left out, the value and proxy are kept; an empty proxy removes it.
	await sealed.saveSealedSecret({ name: 'DEMO_KEY', hosts: ['api.example.com'] });
	assert.equal((await sealed.openSecrets(['DEMO_KEY'])).get('DEMO_KEY')?.value, 'demo-value-123');
	const [unproxied] = await sealed.saveSealedSecret({ name: 'DEMO_KEY', hosts: ['api.example.com'], proxy: '' });
	assert.equal(unproxied?.proxy, null);
	await assert.rejects(sealed.saveSealedSecret({ name: 'lower', value: 'x', hosts: ['a.b'] }), /capital letters/);
	await assert.rejects(sealed.saveSealedSecret({ name: 'NO_HOSTS', value: 'x', hosts: [] }), /at least one host/);
	await assert.rejects(sealed.saveSealedSecret({ name: 'NEW_ONE', hosts: ['a.b'] }), /value/);
	await assert.rejects(sealed.saveSealedSecret({ name: 'BAD_PROXY', value: 'x', hosts: ['a.b'], proxy: 'ftp://x' }), /https:\/\/ or http:\/\//);
	assert.deepEqual(await sealed.deleteSealedSecret('DEMO_KEY'), []);
	assert.equal(sealed.hostAllowed('api.example.org', ['*.example.org']), true);
	assert.equal(sealed.hostAllowed('example.org', ['*.example.org']), false);
	assert.equal(sealed.hostAllowed('evil-example.org', ['*.example.org']), false);
});

test('http_request fills secrets in on the server, through a tunnel the proxy cannot read, and hides them in the answer', async (t) => {
	const tls = certificate();
	if (!tls) return t.skip('openssl is not installed');
	const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
	let token = 0;
	/** An API that signs in with an API key, an MPIN and a TOTP code, and echoes what it was sent. */
	const api = https.createServer(tls, (request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
		request.on('end', () => {
			seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
			response.setHeader('Content-Type', 'application/json');
			if (request.url === '/generate/token') {
				const sent = JSON.parse(body) as { mpin: string; totp: string };
				const good = request.headers['x-api-key'] === 'client-key-1' && sent.mpin === '4321' && sent.totp === totp(TOTP_SECRET);
				token += 1;
				return response.end(good ? JSON.stringify({ status: 'success', data: { token: `token-abcdef-${token}` } }) : JSON.stringify({ status: 'error' }));
			}
			response.end(JSON.stringify({ echo: { authorization: request.headers.authorization ?? null, body } }));
		});
	});
	const apiPort = await listen(api);
	const relayed: Buffer[] = [];
	const connects: string[] = [];
	const proxy = http.createServer().on('connect', (request: http.IncomingMessage, socket: net.Socket) => {
		connects.push(request.url ?? '');
		if (request.headers['proxy-authorization'] !== `Basic ${Buffer.from('anton:pa55').toString('base64')}`) return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
		const upstream = net.connect(Number(request.url!.split(':')[1]), '127.0.0.1', () => {
			socket.write('HTTP/1.1 200 OK\r\n\r\n');
			socket.on('data', (chunk: Buffer) => relayed.push(chunk));
			upstream.on('data', (chunk: Buffer) => relayed.push(chunk));
			socket.pipe(upstream).pipe(socket);
		});
	});
	const proxyPort = await listen(proxy);
	t.after(() => {
		api.close();
		proxy.close();
	});
	const viaProxy = `http://anton:pa55@127.0.0.1:${proxyPort}`;
	await sealed.saveSealedSecret({ name: 'BROKER_KEY', value: 'client-key-1', hosts: ['localhost'], proxy: viaProxy });
	await sealed.saveSealedSecret({ name: 'BROKER_MPIN', value: '4321', hosts: ['localhost'], proxy: viaProxy });
	await sealed.saveSealedSecret({ name: 'BROKER_TOTP', value: TOTP_SECRET, hosts: ['localhost'], proxy: viaProxy });
	const base = `https://localhost:${apiPort}`;
	const trust = { trust: { ca: tls.cert } };

	// Sign in: the token in the answer is kept as a sealed secret, never shown.
	const signIn = await httpRequest(
		'task-1',
		{
			url: `${base}/generate/token`,
			method: 'POST',
			headers: { 'x-api-key': '{{secret:BROKER_KEY}}', 'Content-Type': 'application/json' },
			body: '{"mpin":"{{secret:BROKER_MPIN}}","totp":"{{totp:BROKER_TOTP}}"}',
			save: [{ name: 'BROKER_TOKEN', from: 'token|data.token' }],
		},
		trust,
	);
	assert.match(signIn, /^HTTP 200/);
	assert.match(signIn, /\[BROKER_TOKEN hidden\]/);
	assert.ok(!signIn.includes('token-abcdef-1'), 'the token never reaches the agent');
	assert.match(signIn, /Kept token\|data\.token as the sealed secret BROKER_TOKEN/);
	assert.equal(seen.at(-1)?.headers['x-api-key'], 'client-key-1');
	const kept = (await sealed.sealedSecretsView()).find((secret) => secret.name === 'BROKER_TOKEN');
	assert.deepEqual(kept && [kept.hosts, kept.source], [['localhost'], { by: 'task', taskId: 'task-1' }]);
	assert.equal(kept?.proxy, `http://127.0.0.1:${proxyPort}`, 'the kept token goes through the same proxy');

	// The kept token works, and an API that echoes it back shows it hidden.
	relayed.length = 0;
	const read = await httpRequest('task-1', { url: `${base}/funds?x=1`, headers: { Authorization: '{{secret:BROKER_TOKEN}}' } }, trust);
	assert.equal(seen.at(-1)?.headers.authorization, 'token-abcdef-1');
	assert.ok(!read.includes('token-abcdef-1'));
	assert.match(read, /"authorization":"\[BROKER_TOKEN hidden\]"/);
	const bytes = Buffer.concat(relayed).toString('latin1');
	assert.ok(bytes.length > 0 && !bytes.includes('token-abcdef-1'), 'the proxy relays only ciphertext');
	assert.ok(connects.every((target) => target === `localhost:${apiPort}`), 'the proxy is told only the host and port');

	// A large answer goes to a file in the Library, with the secrets hidden there too.
	const filed = await httpRequest('task-1', { url: `${base}/market/instruments?source=equity`, headers: { Authorization: '{{secret:BROKER_TOKEN}}' }, toFile: 'downloads/instruments.json' }, trust);
	assert.match(filed, /written to downloads\/instruments\.json/);
	const file = new TextDecoder().decode((await readOutput('task-1', 'downloads/instruments.json')) ?? new Uint8Array());
	assert.match(file, /\[BROKER_TOKEN hidden\]/);
	assert.ok(!file.includes('token-abcdef-1'));

	// A secret goes nowhere else: not another host, not plain http, not as the host itself.
	const before = seen.length;
	await assert.rejects(httpRequest('task-1', { url: `https://127.0.0.1:${apiPort}/`, headers: { Authorization: '{{secret:BROKER_TOKEN}}' } }, trust), /may only be sent to localhost, not 127\.0\.0\.1/);
	await assert.rejects(httpRequest('task-1', { url: `http://localhost:${apiPort}/?k={{secret:BROKER_KEY}}` }, trust), /https only/);
	await assert.rejects(httpRequest('task-1', { url: 'https://{{secret:BROKER_KEY}}.example.com/' }, trust), /part of the host/);
	await assert.rejects(httpRequest('task-1', { url: `${base}/`, headers: { a: '{{secret:NOT_SET}}' } }, trust), /No sealed secret is named NOT_SET/);
	assert.equal(seen.length, before, 'none of those requests was sent');

	// A task may renew a token a task kept, never replace what you set.
	await assert.rejects(httpRequest('task-1', { url: `${base}/generate/token`, method: 'POST', body: '{}', save: [{ name: 'BROKER_KEY', from: 'status' }] }, trust), /set in Settings/);
	assert.equal(seen.length, before, 'a request whose answer could not be kept is not sent');
	assert.equal((await sealed.openSecrets(['BROKER_KEY'])).get('BROKER_KEY')?.value, 'client-key-1');
});

test('a tunnel is kept for the next request, reads can skip the proxy, and only useful headers are shown', async (t) => {
	const tls = certificate();
	if (!tls) return t.skip('openssl is not installed');
	const methods: string[] = [];
	const api = https.createServer(tls, (request, response) => {
		methods.push(request.method ?? '');
		request.resume();
		request.on('end', () => {
			response.setHeader('Content-Type', 'application/json');
			response.setHeader('X-Kong-Upstream-Latency', '12');
			response.setHeader('Strict-Transport-Security', 'max-age=1');
			response.setHeader('X-RateLimit-Remaining', '4');
			response.end('{"status":"success"}');
		});
	});
	const apiPort = await listen(api);
	const connects: string[] = [];
	const proxy = http.createServer().on('connect', (request: http.IncomingMessage, socket: net.Socket) => {
		connects.push(request.url ?? '');
		const upstream = net.connect(Number(request.url!.split(':')[1]), '127.0.0.1', () => {
			socket.write('HTTP/1.1 200 OK\r\n\r\n');
			socket.pipe(upstream).pipe(socket);
		});
	});
	const proxyPort = await listen(proxy);
	t.after(() => {
		closeEgressConnections();
		api.close();
		proxy.close();
	});
	const base = `https://localhost:${apiPort}`;
	const trust = { trust: { ca: tls.cert } };
	await sealed.saveSealedSecret({ name: 'REUSE_TOKEN', value: 'reuse-token-1', hosts: ['localhost'], proxy: `http://127.0.0.1:${proxyPort}` });

	const first = await httpRequest('task-2', { url: `${base}/a`, headers: { Authorization: '{{secret:REUSE_TOKEN}}' } }, trust);
	await httpRequest('task-2', { url: `${base}/b`, headers: { Authorization: '{{secret:REUSE_TOKEN}}' } }, trust);
	await httpRequest('task-2', { url: `${base}/order`, method: 'POST', body: '{}', headers: { Authorization: '{{secret:REUSE_TOKEN}}' } }, trust);
	assert.equal(connects.length, 1, 'three requests, one tunnel');
	assert.deepEqual(methods, ['GET', 'GET', 'POST']);
	assert.match(first, /content-type: application\/json/);
	assert.match(first, /x-ratelimit-remaining: 4/);
	assert.ok(!/x-kong|strict-transport-security/i.test(first), 'gateway and security headers are left out');

	// With reads straight out, a GET skips the proxy and a POST still takes it.
	const [view] = (await sealed.saveSealedSecret({ name: 'REUSE_TOKEN', hosts: ['localhost'], readsDirect: true })).filter((secret) => secret.name === 'REUSE_TOKEN');
	assert.equal(view?.readsDirect, true);
	closeEgressConnections();
	connects.length = 0;
	await httpRequest('task-2', { url: `${base}/c`, headers: { Authorization: '{{secret:REUSE_TOKEN}}' } }, trust);
	assert.equal(connects.length, 0, 'the read went straight out');
	await httpRequest('task-2', { url: `${base}/order`, method: 'POST', body: '{}', headers: { Authorization: '{{secret:REUSE_TOKEN}}' } }, trust);
	assert.equal(connects.length, 1, 'the change went through the proxy');
	// Without a proxy there is nothing to skip.
	const [plain] = (await sealed.saveSealedSecret({ name: 'REUSE_TOKEN', hosts: ['localhost'], proxy: '' })).filter((secret) => secret.name === 'REUSE_TOKEN');
	assert.equal(plain?.readsDirect, false);
	await sealed.deleteSealedSecret('REUSE_TOKEN');
});

test('egress refuses a wrong proxy password, a host the proxy does not allow, and plain http through a proxy', async (t) => {
	const tls = certificate();
	if (!tls) return t.skip('openssl is not installed');
	const target = https.createServer(tls, (_request, response) => response.end('ok'));
	const targetPort = await listen(target);
	const proxy = http.createServer().on('connect', (request: http.IncomingMessage, socket: net.Socket) => {
		if (request.headers['proxy-authorization'] !== `Basic ${Buffer.from('anton:pa55').toString('base64')}`) return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
		if (!request.url?.startsWith('localhost:')) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
		const upstream = net.connect(Number(request.url.split(':')[1]), '127.0.0.1', () => {
			socket.write('HTTP/1.1 200 OK\r\n\r\n');
			socket.pipe(upstream).pipe(socket);
		});
	});
	const proxyPort = await listen(proxy);
	t.after(() => {
		target.close();
		proxy.close();
	});
	const send = (address: string, url: string) => egressFetch(proxyParts(address), { url: new URL(url), method: 'GET', headers: {} }, { ca: tls.cert });
	assert.equal((await send(`http://anton:pa55@127.0.0.1:${proxyPort}`, `https://localhost:${targetPort}/`)).body.toString(), 'ok');
	await assert.rejects(send(`http://anton:wrong@127.0.0.1:${proxyPort}`, `https://localhost:${targetPort}/`), /turned down its password/);
	await assert.rejects(send(`http://anton:pa55@127.0.0.1:${proxyPort}`, `https://127.0.0.1:${targetPort}/`), /does not let requests through to 127\.0\.0\.1/);
	await assert.rejects(send(`http://anton:pa55@127.0.0.1:${proxyPort}`, `http://localhost:${targetPort}/`), /over https only/);
	assert.equal(proxyLabel('https://anton:pa55@1-2-3-4.sslip.io:8443'), 'https://1-2-3-4.sslip.io:8443');
});
