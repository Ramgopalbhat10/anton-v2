import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

/*
 * How a request the agent asks for leaves Anton's server (`http-request.ts`).
 * With a proxy, such as a small box with the fixed IP an API allows, it opens
 * a CONNECT tunnel through it and speaks TLS to the API inside the tunnel: the
 * proxy relays bytes it cannot read, so the secrets in the request never show
 * to it. An https:// proxy is reached over TLS as well, so its own password
 * travels encrypted too. Without one, the request goes straight out.
 */

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 32 * 1024 * 1024;

export class EgressError extends Error {}

export type ProxyParts = { secure: boolean; host: string; port: number; auth: string | null };

/** A proxy address: http(s)://user:password@host:port. */
export function proxyParts(address: string): ProxyParts {
	if (!URL.canParse(address)) throw new EgressError('The proxy address is not a URL, such as https://anton:password@1-2-3-4.sslip.io');
	const url = new URL(address);
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EgressError('The proxy address starts with https:// or http://');
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

export type EgressRequest = { url: URL; method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal };
export type EgressResponse = { status: number; headers: Record<string, string>; body: Buffer };

/** Certificates to trust besides the system's, for the target and for an https:// proxy: for tests. */
export type TlsTrust = { ca?: string | Buffer; proxyCa?: string | Buffer };

/** Opens a tunnel to `target` (host:port) through the proxy, resolved once the proxy says it is open. */
function openTunnel(proxy: ProxyParts, target: string, trust: TlsTrust, signal: AbortSignal): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket: net.Socket = proxy.secure
			? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host, ca: trust.proxyCa, ALPNProtocols: ['http/1.1'] })
			: net.connect({ host: proxy.host, port: proxy.port });
		const fail = (error: Error) => {
			socket.destroy();
			reject(error);
		};
		const onAbort = () => fail(new EgressError('The proxy took too long to answer'));
		signal.addEventListener('abort', onAbort, { once: true });
		socket.once('error', (error) => fail(new EgressError(`Could not reach the proxy at ${proxy.host}: ${error.message}`)));
		socket.once(proxy.secure ? 'secureConnect' : 'connect', () => {
			const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n` : '';
			socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
		});
		let head = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf('\r\n\r\n');
			if (end < 0) {
				if (head.length > 16_384) fail(new EgressError('The proxy answered something that is not a proxy reply'));
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
						? `The proxy does not let requests through to ${target}; allow that host on it`
						: `The proxy answered ${status || 'something unexpected'} instead of opening a tunnel`;
			fail(new EgressError(why));
		};
		socket.on('data', onData);
	});
}

function readAll(response: IncomingMessage): Promise<EgressResponse> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		response.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BYTES) response.destroy(new Error('The answer was too large'));
			else chunks.push(chunk);
		});
		response.once('end', () => {
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
			resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
		});
		response.once('error', reject);
	});
}

/** Sends one request, through `proxy` when one is given (https:// targets only), else straight out. Redirects are not followed. */
export async function egressFetch(proxy: ProxyParts | null, request: EgressRequest, trust: TlsTrust = {}): Promise<EgressResponse> {
	const { url } = request;
	const secure = url.protocol === 'https:';
	if (!secure && url.protocol !== 'http:') throw new EgressError('Only http:// and https:// addresses can be fetched');
	if (proxy && !secure) throw new EgressError('Requests go through the proxy over https only');
	const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
	const port = Number(url.port) || (secure ? 443 : 80);
	const tunnel = proxy ? await openTunnel(proxy, `${url.hostname}:${port}`, trust, signal) : null;
	const body = request.body === undefined ? undefined : Buffer.from(request.body, 'utf8');
	return new Promise<EgressResponse>((resolve, reject) => {
		const options: https.RequestOptions = {
			host: url.hostname,
			port,
			path: `${url.pathname}${url.search}`,
			method: request.method,
			headers: { ...request.headers, ...(body ? { 'Content-Length': String(body.length) } : {}) },
			signal,
			// Node uses createConnection only when no agent is given; without a tunnel, a fresh agent keeps no connection open.
			...(tunnel ? { createConnection: () => tls.connect({ socket: tunnel, servername: url.hostname, ca: trust.ca, ALPNProtocols: ['http/1.1'] }) } : { agent: false }),
			...(secure ? { ca: trust.ca, servername: url.hostname } : {}),
		};
		const sent = (secure ? https : http).request(options, (response) => readAll(response).then(resolve, reject));
		sent.once('error', (error) => {
			tunnel?.destroy();
			const why = signal.aborted ? 'it took too long to answer' : error.message;
			// With a password the proxy did not take, a probe-resistant proxy pretends to tunnel and the TLS that follows fails.
			const hint = proxy && /SSL|TLS|wrong version|socket hang up|ECONNRESET/i.test(error.message) ? ' (if this keeps happening, check the proxy address and password)' : '';
			reject(new EgressError(`Could not reach ${url.hostname}: ${why}${hint}`));
		});
		sent.end(body);
	});
}
