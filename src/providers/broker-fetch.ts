import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { BrokerError } from '../core/errors.ts';
import type { BrokerFetch, BrokerResponse } from '../core/ports.ts';

/*
 * How broker calls leave Anton's server. With a proxy (a small box with a fixed
 * IP the broker allows orders from), each call opens a CONNECT tunnel through it
 * and then speaks TLS to the broker inside the tunnel: the proxy relays bytes it
 * cannot read, so tokens, PINs and orders never show to it. An https:// proxy
 * is reached over TLS as well, so even its own password travels encrypted.
 * Without one, calls go straight out from this server's address.
 */

const TIMEOUT_MS = 20_000;
/** An instrument list is a few megabytes of CSV; nothing a broker answers is near this. */
const MAX_BYTES = 64 * 1024 * 1024;

export type ProxyParts = { secure: boolean; host: string; port: number; auth: string | null };

/** A proxy address as Settings › Trading takes it: http(s)://user:password@host:port. */
export function proxyParts(address: string): ProxyParts {
	if (!URL.canParse(address)) throw new BrokerError('The proxy address is not a URL, such as https://anton:password@1-2-3-4.sslip.io', 'refused');
	const url = new URL(address);
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BrokerError('The proxy address starts with https:// or http://', 'refused');
	const auth = url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : null;
	return { secure: url.protocol === 'https:', host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80), auth };
}

/** The proxy's address without its password, to show. */
export function proxyLabel(address: string): string {
	try {
		const parts = proxyParts(address);
		return `${parts.secure ? 'https' : 'http'}://${parts.host}${parts.port === (parts.secure ? 443 : 80) ? '' : `:${parts.port}`}`;
	} catch {
		return 'not a valid address';
	}
}

type TlsOptions = {
	/** Certificates to trust for the broker, besides the system's: for tests. */
	ca?: string | Buffer;
	/** The same for an https:// proxy. */
	proxyCa?: string | Buffer;
};

/** Opens a tunnel to `target` (host:port) through the proxy, resolved once the proxy says it is open. */
function openTunnel(proxy: ProxyParts, target: string, options: TlsOptions, signal: AbortSignal): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket: net.Socket = proxy.secure
			? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host, ca: options.proxyCa, ALPNProtocols: ['http/1.1'] })
			: net.connect({ host: proxy.host, port: proxy.port });
		const fail = (error: Error) => {
			socket.destroy();
			reject(error);
		};
		const onAbort = () => fail(new BrokerError('The proxy took too long to answer', 'unreachable'));
		signal.addEventListener('abort', onAbort, { once: true });
		socket.once('error', (error) => fail(new BrokerError(`Could not reach the proxy at ${proxy.host}: ${error.message}`, 'unreachable')));
		socket.once(proxy.secure ? 'secureConnect' : 'connect', () => {
			const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n` : '';
			socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
		});
		let head = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf('\r\n\r\n');
			if (end < 0) {
				if (head.length > 16_384) fail(new BrokerError('The proxy answered something that is not a proxy reply', 'unreachable'));
				return;
			}
			socket.off('data', onData);
			signal.removeEventListener('abort', onAbort);
			socket.removeAllListeners('error');
			const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString('latin1'))?.[1] ?? 0);
			if (status === 200) return resolve(socket);
			const why =
				status === 407
					? 'The proxy turned down its password'
					: status === 403
						? `The proxy does not let calls through to ${target}; allow that host on it`
						: `The proxy answered ${status || 'something unexpected'} instead of opening a tunnel`;
			fail(new BrokerError(why, 'unreachable'));
		};
		socket.on('data', onData);
	});
}

function readAll(response: IncomingMessage): Promise<BrokerResponse> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		response.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BYTES) response.destroy(new Error('The answer was too large'));
			else chunks.push(chunk);
		});
		response.once('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
		response.once('error', reject);
	});
}

/** A `BrokerFetch` that goes through `proxy` when one is given, else straight out. Only https:// targets. */
export function brokerFetch(proxy: string | null, options: TlsOptions = {}): BrokerFetch {
	const parts = proxy ? proxyParts(proxy) : null;
	return async (address, init) => {
		const url = new URL(address);
		if (url.protocol !== 'https:') throw new BrokerError('Broker calls go over https only', 'refused');
		const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
		const port = Number(url.port) || 443;
		const tunnel = parts ? await openTunnel(parts, `${url.hostname}:${port}`, options, signal) : null;
		const body = init.body === undefined ? undefined : Buffer.from(init.body, 'utf8');
		return new Promise<BrokerResponse>((resolve, reject) => {
			const request = https.request(
				{
					host: url.hostname,
					port,
					path: `${url.pathname}${url.search}`,
					method: init.method,
					headers: { ...init.headers, ...(body ? { 'Content-Length': String(body.length) } : {}) },
					ca: options.ca,
					servername: url.hostname,
					signal,
					// Node uses createConnection only when no agent is given; without a tunnel, a fresh agent keeps no connection open.
					...(tunnel ? { createConnection: () => tls.connect({ socket: tunnel, servername: url.hostname, ca: options.ca, ALPNProtocols: ['http/1.1'] }) } : { agent: false }),
				},
				(response) => readAll(response).then(resolve, reject),
			);
			request.once('error', (error) => {
				tunnel?.destroy();
				const why = signal.aborted ? 'it took too long to answer' : error.message;
				// With a password the proxy did not take, a probe-resistant proxy pretends to tunnel and the TLS that follows fails.
				const hint = parts && /SSL|TLS|wrong version|socket hang up|ECONNRESET/i.test(error.message) ? ' (if this keeps happening, check the proxy address and password)' : '';
				reject(new BrokerError(`Could not reach ${url.hostname}: ${why}${hint}`, 'unreachable'));
			});
			request.end(body);
		});
	};
}
