import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-trading-'));
process.env.ANTON_DATA_DIR = dir;

const { setProviders } = await import('../src/providers/index.ts');
const { indstocksBroker, instrumentsFromCsv, bestMatches, csvCells, quoteCodeFor } = await import('../src/providers/indstocks/broker.ts');
const { brokerFetch, proxyLabel } = await import('../src/providers/broker-fetch.ts');
const { totp, base32Bytes } = await import('../src/core/totp.ts');
const trading = await import('../src/services/trading.ts');
const connectorTools = await import('../src/services/connector-tools.ts');
const { getSetting, setSetting } = await import('../src/db/settings.ts');
const { appDb } = await import('../src/db/client.ts');
const { BrokerError } = await import('../src/core/errors.ts');
const { onChange } = await import('../src/core/changes.ts');

after(() => rmSync(dir, { recursive: true, force: true }));

const SECRET = 'JBSWY3DPEHPK3PXP';
const API = 'https://broker.test';

type Seen = { method: string; path: string; headers: Record<string, string>; body: string | undefined };

/** An INDstocks that mints a token from TOTP, answers reads, and records orders. */
function fakeIndstocks() {
	const seen: Seen[] = [];
	const orders: Array<Record<string, unknown>> = [];
	let tokens = 0;
	let live: string | null = null;
	let ltp = 250;
	let down = false;
	const fetch = async (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }) => {
		const { pathname, search } = new URL(url);
		seen.push({ method: init.method, path: `${pathname}${search}`, headers: init.headers, body: init.body });
		const reply = (status: number, value: unknown) => ({ status, text: typeof value === 'string' ? value : JSON.stringify(value) });
		if (pathname === '/generate/token') {
			const body = JSON.parse(init.body ?? '{}');
			if (init.headers['x-api-key'] !== 'client-1' || body.mpin !== '1234' || body.totp !== totp(SECRET)) return reply(403, { status: 'error', error_type: 'InputException', message: 'Wrong MPIN or TOTP' });
			tokens += 1;
			live = `token-${tokens}`;
			return reply(200, { status: 'success', data: { token: live } });
		}
		if (init.headers.Authorization !== live) return reply(403, { status: 'error', error_type: 'TokenException', message: 'Invalid token' });
		if (pathname === '/user/profile') return reply(200, { status: 'success', data: { name: 'Subbu', user_id: '710354' } });
		if (pathname === '/funds') return reply(200, { status: 'success', data: { available: 50_000 } });
		if (pathname === '/portfolio/holdings') return reply(200, { status: 'success', data: [{ symbol: 'CUPID', total_qty: 1 }] });
		if (pathname === '/portfolio/positions') return reply(200, { status: 'success', data: [] });
		if (pathname === '/order-book') return reply(200, { status: 'success', data: orders });
		if (pathname === '/market/quotes/ltp') {
			const code = new URL(url).searchParams.get('scrip-codes')!;
			return reply(200, { status: 'success', data: { [code]: { live_price: ltp } } });
		}
		if (pathname === '/market/quotes/full') return reply(200, { status: 'success', data: { NSE_2885: { live_price: ltp } } });
		if (pathname === '/market/instruments') {
			return reply(
				200,
				'EXCH,SEGMENT,SECURITY_ID,INSTRUMENT_NAME,EXPIRY_CODE,TRADING_SYMBOL,LOT_UNITS,CUSTOM_SYMBOL,EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE\n' +
					'NSE,E,2885,EQUITY,0,RELIANCE,1,Reliance Industries,,,,0.05\n' +
					'BSE,E,500325,EQUITY,0,RELIANCE,1,Reliance Industries,,,,0.05\n' +
					'NSE,E,9999,EQUITY,0,RELINFRA,1,"Reliance Infrastructure, Ltd",,,,0.05\n',
			);
		}
		if (pathname === '/order' && init.method === 'POST') {
			if (down) throw new BrokerError('Could not reach broker.test: socket hang up', 'unreachable');
			const body = JSON.parse(init.body ?? '{}');
			if (body.qty > 1000) return reply(400, { status: 'error', error_type: 'RequestValidationException', message: 'QtyWithinFreezeQty' });
			orders.push(body);
			return reply(200, { status: 'success', data: { order_id: `EQ-${orders.length}`, order_status: 'INITIATED' } });
		}
		if (pathname === '/order/cancel') return reply(200, { status: 'success', data: { order_id: JSON.parse(init.body!).order_id, order_status: 'CANCELLED' } });
		return reply(404, { status: 'error', error_type: 'NotFoundException', message: 'No such path' });
	};
	return {
		seen,
		orders,
		fetch,
		get tokens() {
			return tokens;
		},
		revoke: () => (live = null),
		setPrice: (price: number) => (ltp = price),
		setDown: (value: boolean) => (down = value),
	};
}

const broker = fakeIndstocks();
const proxies: Array<string | null> = [];
setProviders({
	sandbox: {} as never,
	store: {} as never,
	git: {} as never,
	models: { name: 'openrouter', list: async () => [] },
	brokers: [indstocksBroker({ apiUrl: API })],
	brokerFetch: (proxy) => {
		proxies.push(proxy);
		return broker.fetch;
	},
});

/** Lets the next sign-in happen now, as if the last were over a minute ago. */
async function ageSession() {
	const session = await getSetting<Record<string, string> | null>('broker-session:indstocks', null);
	if (session) await setSetting('broker-session:indstocks', { ...session, mintedAt: new Date(Date.now() - 120_000).toISOString() });
}

test('TOTP codes match RFC 6238 and an authenticator app', () => {
	// RFC 6238's SHA-1 secret is the ASCII "12345678901234567890".
	const rfc = Buffer.from('12345678901234567890');
	assert.equal(totp(rfc, 59_000, { digits: 8 }), '94287082');
	assert.equal(totp(rfc, 1_111_111_109_000, { digits: 8 }), '07081804');
	assert.equal(totp(rfc, 20_000_000_000_000, { digits: 8 }), '65353130');
	assert.deepEqual(base32Bytes('GEZD GNBV gy3tqojq GEZDGNBVGY3TQOJQ'), rfc, 'spaces and case do not matter');
	assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
	assert.throws(() => base32Bytes('not base32!'), /base32/);
});

test('INDstocks instrument lists are read by column, matched best first, and quoted by segment', () => {
	assert.deepEqual(csvCells('a,"b, c","say ""hi"""'), ['a', 'b, c', 'say "hi"']);
	const rows = instrumentsFromCsv('EXCH,SEGMENT,SECURITY_ID,TRADING_SYMBOL,LOT_UNITS,CUSTOM_SYMBOL,STRIKE_PRICE,OPTION_TYPE\nNSE,FNO,58757,NIFTY25JUL27400CE,75,NIFTY 3 JUL 27400 CE,27400,CE\n', 'fno');
	assert.deepEqual(rows[0], {
		securityId: '58757',
		exchange: 'NSE',
		segment: 'DERIVATIVE',
		symbol: 'NIFTY25JUL27400CE',
		name: 'NIFTY 3 JUL 27400 CE',
		quoteCode: 'NFO_58757',
		lotSize: 75,
		tickSize: 0,
		expiry: null,
		strike: 27400,
		optionType: 'CE',
	});
	assert.equal(bestMatches(rows, 'nifty 27400 ce').length, 1);
	assert.equal(bestMatches(rows, 'nifty 27500').length, 0, 'every word must match');
	assert.equal(instrumentsFromCsv('EXCH,SEGMENT,SECURITY_ID\nNSE,NIFTY 50,40000001\n', 'index')[0]?.name, 'NIFTY 50', 'the index list is read by position');
	assert.equal(quoteCodeFor({ exchange: 'BSE', segment: 'EQUITY', securityId: '500325' }), 'BSE_500325');
	assert.equal(quoteCodeFor({ exchange: 'MCX', segment: 'COMMODITY', securityId: '495214' }), 'MCX_495214');
});

test('credentials are saved on the server and never shown again; the agent reads through one sign-in', async () => {
	assert.deepEqual(await connectorTools.setUpConnectors(), [], 'a broker without a sign-in is not offered');
	const changes: string[] = [];
	const stop = onChange((change) => changes.push(change.kind));
	const view = await trading.saveBrokerSettings('indstocks', {
		credentials: { clientId: 'client-1', mpin: '1234', totpSecret: SECRET },
		proxy: 'https://anton:pa55word@13-233-10-20.sslip.io',
	});
	stop();
	assert.ok(changes.includes('connectors'));
	assert.equal(view.ready, true);
	assert.equal(view.proxy, 'https://13-233-10-20.sslip.io', 'the proxy shows without its password');
	assert.deepEqual(
		view.fields.map((field) => [field.key, field.set]),
		[
			['clientId', true],
			['mpin', true],
			['totpSecret', true],
			['accessToken', false],
		],
	);
	const shown = JSON.stringify(await trading.brokersView());
	for (const secret of ['client-1', '1234', SECRET, 'pa55word']) assert.ok(!shown.includes(secret), `${secret} never leaves the server`);
	await assert.rejects(trading.saveBrokerSettings('indstocks', { proxy: 'ftp://x' }), /https:\/\/ or http:\/\//);
	await assert.rejects(trading.saveBrokerSettings('indstocks', { credentials: { password: 'x' } }), /no credential named password/);

	assert.deepEqual(
		(await connectorTools.setUpConnectors()).map(({ id, kind }) => `${kind}:${id}`),
		['broker:indstocks'],
	);
	const listed = await connectorTools.connectorToolsText('indstocks');
	for (const tool of ['account', 'portfolio', 'orders', 'find_instrument', 'quotes', 'place_order', 'modify_order', 'cancel_order']) assert.match(listed, new RegExp(`indstocks_${tool}`));

	const account = await connectorTools.callConnectorTool('t1', 'indstocks_account', {});
	assert.match(account.output, /profile: \{"name":"Subbu"/);
	assert.match(account.output, /funds: \{"available":50000\}/);
	assert.equal(proxies.at(-1), 'https://anton:pa55word@13-233-10-20.sslip.io', 'calls go out through the proxy');
	await connectorTools.callConnectorTool('t1', 'indstocks_portfolio', {});
	assert.equal(broker.tokens, 1, 'one sign-in serves every call');
	const signIn = broker.seen.find((request) => request.path === '/generate/token')!;
	assert.equal(signIn.headers['x-api-key'], 'client-1');
	assert.ok((await trading.brokerView('indstocks')).sessionEndsAt, 'the view says a sign-in is held, not what it is');

	const found = await connectorTools.callConnectorTool('t1', 'indstocks_find_instrument', { query: 'reliance' });
	assert.match(found.output, /security_id 2885 · RELIANCE · Reliance Industries · NSE EQUITY · quote NSE_2885/);
	assert.match(found.output, /Reliance Infrastructure, Ltd/, 'a quoted cell keeps its comma');
	assert.match((await connectorTools.callConnectorTool('t1', 'indstocks_quotes', { codes: ['NSE_2885'] })).output, /"live_price":250/);
	await assert.rejects(connectorTools.callConnectorTool('t1', 'indstocks_quotes', { codes: ['reliance'] }), /quote code such as NSE_2885/);
});

test('a token that stops working is renewed once, at most once a minute', async () => {
	broker.revoke();
	await assert.rejects(connectorTools.callConnectorTool('t1', 'indstocks_orders', {}), /one sign-in a minute/, 'the broker allows a sign-in a minute');
	await ageSession();
	const before = broker.tokens;
	assert.match((await connectorTools.callConnectorTool('t1', 'indstocks_orders', {})).output, /^orders: \[/);
	assert.equal(broker.tokens, before + 1);
});

test('an order only asks; Place sends it as shown, once, and within the limits', async () => {
	await trading.saveBrokerSettings('indstocks', { maxOrderValue: 10_000, maxOrdersPerDay: 2 });
	await ageSession();
	const sentBefore = broker.orders.length;
	const order = { side: 'BUY', exchange: 'NSE', segment: 'EQUITY', product: 'CNC', order_type: 'LIMIT', security_id: '2885', quantity: 10, limit_price: 240, symbol: 'RELIANCE', tag: 'from Anton' };
	const asked = await connectorTools.callConnectorTool('t2', 'indstocks_place_order', order);
	assert.equal(asked.order?.state, 'pending');
	assert.equal(asked.order?.value, 2400);
	assert.match(asked.output, /The user now sees "Buy 10 RELIANCE at 240" \(worth about 2,400\) with Place and Don't place/);
	assert.match(asked.output, new RegExp(`\\[order:${asked.order!.id}\\]`));
	assert.equal(broker.orders.length, sentBefore, 'asking sends nothing');
	assert.equal(trading.orderLine(asked.order!.action), 'Buy 10 RELIANCE at 240');

	await assert.rejects(trading.decideOrder('another-task', asked.order!.id, true), /No order waits/, 'another task cannot answer it');
	const placed = await trading.decideOrder('t2', asked.order!.id, true);
	assert.equal(placed.state, 'done');
	assert.equal(placed.orderId, `EQ-${sentBefore + 1}`);
	assert.deepEqual(broker.orders.at(-1), {
		txn_type: 'BUY',
		exchange: 'NSE',
		segment: 'EQUITY',
		product: 'CNC',
		order_type: 'LIMIT',
		validity: 'DAY',
		security_id: '2885',
		qty: 10,
		is_amo: false,
		limit_price: 240,
		remarks: 'from Anton',
	});
	await assert.rejects(trading.decideOrder('t2', asked.order!.id, true), /already sent/, 'pressing Place again sends nothing');
	assert.equal(broker.orders.length, sentBefore + 1);

	// Over the value an order may have: refused before the user is asked.
	await assert.rejects(connectorTools.callConnectorTool('t2', 'indstocks_place_order', { ...order, quantity: 100 }), /worth about 24,000, over the 10,000/);
	// A market order is valued at the live price.
	broker.setPrice(2_000);
	await assert.rejects(connectorTools.callConnectorTool('t2', 'indstocks_place_order', { ...order, order_type: 'MARKET', limit_price: undefined }), /worth about 20,000/);
	broker.setPrice(250);
	await assert.rejects(connectorTools.callConnectorTool('t2', 'indstocks_place_order', { ...order, order_type: 'LIMIT', limit_price: undefined }), /LIMIT order needs limit_price/);

	// Don't place sends nothing.
	const second = await connectorTools.callConnectorTool('t2', 'indstocks_place_order', order);
	assert.equal((await trading.decideOrder('t2', second.order!.id, false)).state, 'declined');
	assert.equal(broker.orders.length, sentBefore + 1);

	// The day's cap counts what was placed, from every task.
	const third = await connectorTools.callConnectorTool('t3', 'indstocks_place_order', order);
	assert.equal((await trading.decideOrder('t3', third.order!.id, true)).state, 'done');
	await assert.rejects(connectorTools.callConnectorTool('t3', 'indstocks_place_order', order), /2 orders were placed today/);

	// A cancel is not a new order, so the cap leaves it; it still asks.
	const cancel = await connectorTools.callConnectorTool('t3', 'indstocks_cancel_order', { order_id: 'EQ-1', segment: 'EQUITY' });
	assert.match(cancel.output, /"Cancel order EQ-1"/);
	assert.equal((await trading.decideOrder('t3', cancel.order!.id, true)).state, 'done');
	assert.deepEqual(
		(await trading.orderApprovals('t2')).map((each) => each.state),
		['done', 'declined'],
	);
});

test('a refused order fails, one with no answer is never sent again, and a stale one is not placed', async () => {
	await trading.saveBrokerSettings('indstocks', { maxOrdersPerDay: 50, maxOrderValue: 10_000_000 });
	const order = { side: 'SELL', exchange: 'NSE', segment: 'EQUITY', product: 'INTRADAY', order_type: 'LIMIT', security_id: '2885', quantity: 5000, limit_price: 250 };
	const refused = await connectorTools.callConnectorTool('t4', 'indstocks_place_order', order);
	const failed = await trading.decideOrder('t4', refused.order!.id, true);
	assert.equal(failed.state, 'failed');
	assert.match(failed.problem ?? '', /RequestValidationException.*QtyWithinFreezeQty/);

	broker.setDown(true);
	const lost = await connectorTools.callConnectorTool('t4', 'indstocks_place_order', { ...order, quantity: 5 });
	const unknown = await trading.decideOrder('t4', lost.order!.id, true);
	broker.setDown(false);
	assert.equal(unknown.state, 'unknown', 'no answer: the order may have gone');
	await assert.rejects(trading.decideOrder('t4', lost.order!.id, true), /no answer came; look at the order book/);

	const stale = await connectorTools.callConnectorTool('t4', 'indstocks_place_order', { ...order, quantity: 5 });
	const db = await appDb();
	await db.execute({ sql: 'UPDATE order_approvals SET created_at = ? WHERE id = ?', args: [new Date(Date.now() - 31 * 60_000).toISOString(), stale.order!.id] });
	assert.equal((await trading.orderApprovals('t4')).find((each) => each.id === stale.order!.id)?.state, 'expired', 'it shows as expired before anyone presses');
	await assert.rejects(trading.decideOrder('t4', stale.order!.id, true), /over 30 minutes ago/);
});

test('with trading off the agent only reads, and with the broker off it has nothing', async () => {
	await trading.saveBrokerSettings('indstocks', { trading: false });
	const listed = await connectorTools.connectorToolsText('');
	assert.match(listed, /indstocks_account/);
	assert.doesNotMatch(listed, /indstocks_place_order|indstocks_cancel_order/);
	await assert.rejects(connectorTools.callConnectorTool('t5', 'indstocks_place_order', {}), /No connector that is on has a tool named indstocks_place_order/);
	await trading.saveBrokerSettings('indstocks', { trading: true, enabled: false });
	assert.match(await connectorTools.connectorToolsText(''), /## INDstocks: it is off in Settings › Trading/);
	await assert.rejects(connectorTools.callConnectorTool('t5', 'indstocks_account', {}), /INDstocks is off/);
	await trading.saveBrokerSettings('indstocks', { enabled: true });
});

test('the trading day starts at midnight on the broker’s clock', () => {
	assert.equal(trading.startOfDay('Asia/Kolkata', new Date('2026-11-03T20:00:00Z')), '2026-11-03T18:30:00.000Z');
	assert.equal(trading.startOfDay('Asia/Kolkata', new Date('2026-11-03T17:00:00Z')), '2026-11-02T18:30:00.000Z');
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

test('through a proxy, calls go in an encrypted tunnel the proxy cannot read', async (t) => {
	const tls = certificate();
	if (!tls) return t.skip('openssl is not installed');
	const target = https.createServer(tls, (request, response) => {
		response.setHeader('Content-Type', 'application/json');
		response.end(JSON.stringify({ path: request.url, auth: request.headers.authorization ?? null }));
	});
	const targetPort = await listen(target);
	/** A forward proxy that wants a password and lets calls through only to localhost, and keeps every byte it relays. */
	const relayed: Buffer[] = [];
	const connects: string[] = [];
	const onConnect = (request: http.IncomingMessage, socket: net.Socket) => {
		connects.push(request.url ?? '');
		if (request.headers['proxy-authorization'] !== `Basic ${Buffer.from('anton:pa55').toString('base64')}`) return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
		if (!request.url?.startsWith('localhost:')) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
		const upstream = net.connect(Number(request.url.split(':')[1]), '127.0.0.1', () => {
			socket.write('HTTP/1.1 200 OK\r\n\r\n');
			socket.on('data', (chunk: Buffer) => relayed.push(chunk));
			upstream.on('data', (chunk: Buffer) => relayed.push(chunk));
			socket.pipe(upstream).pipe(socket);
		});
	};
	const plainProxy = http.createServer().on('connect', onConnect);
	const tlsProxy = https.createServer(tls).on('connect', onConnect);
	const [plainPort, tlsPort] = [await listen(plainProxy), await listen(tlsProxy)];
	t.after(() => {
		target.close();
		plainProxy.close();
		tlsProxy.close();
	});

	const call = (proxy: string | null) => brokerFetch(proxy, { ca: tls.cert, proxyCa: tls.cert })(`https://localhost:${targetPort}/order?x=1`, { method: 'POST', headers: { Authorization: 'secret-token' }, body: '{"mpin":"1234"}' });
	for (const proxy of [`http://anton:pa55@127.0.0.1:${plainPort}`, `https://anton:pa55@localhost:${tlsPort}`]) {
		relayed.length = 0;
		const answer = await call(proxy);
		assert.equal(answer.status, 200);
		assert.deepEqual(JSON.parse(answer.text), { path: '/order?x=1', auth: 'secret-token' });
		const bytes = Buffer.concat(relayed).toString('latin1');
		assert.ok(bytes.length > 0);
		assert.ok(!bytes.includes('secret-token') && !bytes.includes('1234'), 'the proxy relays only ciphertext');
	}
	assert.deepEqual(connects.slice(0, 2), [`localhost:${targetPort}`, `localhost:${targetPort}`], 'the proxy is told only the host and port');
	assert.equal((await call(null)).status, 200, 'without a proxy calls go straight out');
	await assert.rejects(call(`http://anton:wrong@127.0.0.1:${plainPort}`), /turned down its password/);
	await assert.rejects(
		brokerFetch(`http://anton:pa55@127.0.0.1:${plainPort}`, { ca: tls.cert })(`https://127.0.0.1:${targetPort}/`, { method: 'GET', headers: {} }),
		/does not let calls through to 127\.0\.0\.1/,
	);
	await assert.rejects(brokerFetch(null)('http://localhost/', { method: 'GET', headers: {} }), /https only/);
	assert.equal(proxyLabel('https://anton:pa55@1-2-3-4.sslip.io:8443'), 'https://1-2-3-4.sslip.io:8443');
});
