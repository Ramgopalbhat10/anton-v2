import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';

/*
 * How a request the agent asks for leaves Anton's server (`http-request.ts`).
 * With a proxy, such as a small box with the fixed IP an API allows, it opens
 * a CONNECT tunnel through it and speaks TLS to the API inside the tunnel: the
 * proxy relays bytes it cannot read, so the secrets in the request never show
 * to it. An https:// proxy is reached over TLS as well, so its own password
 * travels encrypted too. Without one, the request goes straight out.
 *
 * Connections are kept open for a little while and reused, one pool per proxy
 * and target: opening a tunnel costs a TLS handshake with the proxy, the
 * CONNECT and a TLS handshake with the API, several round trips that a far
 * proxy turns into seconds. A read that finds its kept connection closed by
 * the other end is sent again once; anything else is never resent, since an
 * order may have gone through.
 */

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 32 * 1024 * 1024;
/** How long an idle connection is kept: well under what servers and proxies allow, so it is rarely closed under us. */
const IDLE_MS = 20_000;

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

/** Keeps connections to one target through one proxy: each new one is a tunnel with TLS to the target inside it. */
class TunnelAgent extends https.Agent {
	private readonly proxy: ProxyParts;
	private readonly trust: TlsTrust;

	constructor(proxy: ProxyParts, trust: TlsTrust) {
		super({ keepAlive: true, maxSockets: 4, timeout: IDLE_MS, scheduling: 'lifo' });
		this.proxy = proxy;
		this.trust = trust;
	}

	override createConnection(options: https.RequestOptions, done?: (error: Error | null, stream: Duplex) => void): undefined {
		const host = String(options.host ?? options.hostname);
		const port = Number(options.port) || 443;
		const finish = (error: Error | null, socket?: Duplex) => done?.(error, socket as Duplex);
		openTunnel(this.proxy, `${host}:${port}`, this.trust, AbortSignal.timeout(TIMEOUT_MS)).then((tunnel) => {
			const secured = tls.connect({ socket: tunnel, servername: host, ca: this.trust.ca, ALPNProtocols: ['http/1.1'] });
			const fail = (error: Error) => {
				tunnel.destroy();
				finish(error);
			};
			secured.once('error', fail);
			secured.once('secureConnect', () => {
				secured.off('error', fail);
				finish(null, secured);
			});
		}, finish);
		return undefined;
	}
}

const agents = new Map<string, http.Agent>();

/** The pool for this proxy, target scheme and trust; a test's own certificates get a pool of their own. */
function agentFor(proxy: ProxyParts | null, secure: boolean, trust: TlsTrust): http.Agent {
	const key = JSON.stringify([proxy, secure, String(trust.ca ?? ''), String(trust.proxyCa ?? '')]);
	const kept = agents.get(key);
	if (kept) return kept;
	const agent: http.Agent = proxy
			? new TunnelAgent(proxy, trust)
			: secure
				? new https.Agent({ keepAlive: true, maxSockets: 4, timeout: IDLE_MS, scheduling: 'lifo' })
			: new http.Agent({ keepAlive: true, maxSockets: 4, timeout: IDLE_MS, scheduling: 'lifo' });
	agents.set(key, agent);
	return agent;
}

/** Closes every kept connection: when a proxy's address or password changes, and in tests. */
export function closeEgressConnections() {
	for (const agent of agents.values()) agent.destroy();
	agents.clear();
}

/** A kept connection the other end had closed: the request never reached it. */
const closedUnderUs = (error: NodeJS.ErrnoException, reused: boolean) => reused && (error.code === 'ECONNRESET' || error.code === 'EPIPE' || /socket hang up/i.test(error.message));

/** Sends one request, through `proxy` when one is given (https:// targets only), else straight out. Redirects are not followed. */
export async function egressFetch(proxy: ProxyParts | null, request: EgressRequest, trust: TlsTrust = {}): Promise<EgressResponse> {
	const { url } = request;
	const secure = url.protocol === 'https:';
	if (!secure && url.protocol !== 'http:') throw new EgressError('Only http:// and https:// addresses can be fetched');
	if (proxy && !secure) throw new EgressError('Requests go through the proxy over https only');
	const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
	const port = Number(url.port) || (secure ? 443 : 80);
	const body = request.body === undefined ? undefined : Buffer.from(request.body, 'utf8');
	// Only a read is safe to send twice.
	const idempotent = request.method === 'GET' || request.method === 'HEAD';
	const send = (retry: boolean): Promise<EgressResponse> =>
		new Promise<EgressResponse>((resolve, reject) => {
			const options: https.RequestOptions = {
				host: url.hostname,
				port,
				path: `${url.pathname}${url.search}`,
				method: request.method,
				headers: { ...request.headers, ...(body ? { 'Content-Length': String(body.length) } : {}) },
				signal,
				agent: agentFor(proxy, secure, trust),
				...(secure ? { ca: trust.ca, servername: url.hostname } : {}),
			};
			const sent = (secure ? https : http).request(options, (response) => readAll(response).then(resolve, reject));
			sent.once('error', (error: NodeJS.ErrnoException) => {
				if (retry && !signal.aborted && closedUnderUs(error, sent.reusedSocket)) return void send(false).then(resolve, reject);
				if (error instanceof EgressError) return reject(error);
				const why = signal.aborted ? 'it took too long to answer' : error.message;
				// With a password the proxy did not take, a probe-resistant proxy pretends to tunnel and the TLS that follows fails.
				const hint = proxy && /SSL|TLS|wrong version|socket hang up|ECONNRESET/i.test(error.message) ? ' (if this keeps happening, check the proxy address and password)' : '';
				const unsure = !idempotent && sent.reusedSocket ? ' It may or may not have been received.' : '';
				reject(new EgressError(`Could not reach ${url.hostname}: ${why}${hint}${unsure}`));
			});
			sent.end(body);
		});
	return send(idempotent);
}
