import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { generalSettings } from './general.ts';
import { isRenderPath } from './renders.ts';

/*
 * The requests a page makes (src/services/renders.ts). The page itself still
 * reaches nothing: its bootstrap gives it a fetch() that hands each request to
 * its frame page, Anton's own, which sends it here, and Anton makes it. So a
 * page can call any public API, whether or not that API allows other origins
 * (CORS), and nothing else:
 *
 * - only http and https, to addresses on the public internet: the address is
 *   checked as the connection is made, at every redirect, so a name that
 *   resolves to this machine, its private network or a cloud metadata service
 *   is refused, even when it changes between lookups;
 * - with no cookies of the user's or Anton's: the page's own headers, less
 *   those that would speak for someone else (Cookie, Origin, Referer, Host);
 * - within limits: a megabyte up, five down, twenty seconds, eight at a time
 *   for each task.
 *
 * Settings › General › Pages reach the web (`pageNetwork`) turns it off.
 */

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_AT_ONCE = 8;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const USER_AGENT = 'Mozilla/5.0 (compatible; Anton page)';

/** A request Anton refused or could not complete, said so to the page. */
export class PageFetchError extends Error {
	readonly status: number;
	constructor(message: string, status = 502) {
		super(message);
		this.status = status;
	}
}

const NOT_PUBLIC = new BlockList();
for (const [network, bits] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
] as const)
	NOT_PUBLIC.addSubnet(network, bits, 'ipv4');
// IPv4-mapped addresses (::ffff:a.b.c.d) are checked against the IPv4 ranges above; these carry an IPv4 address some other way, or none.
for (const [network, bits] of [
	['::', 96],
	['::1', 128],
	['64:ff9b::', 96],
	['100::', 64],
	['2001::', 32],
	['2001:db8::', 32],
	['2002::', 16],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['ff00::', 8],
] as const)
	NOT_PUBLIC.addSubnet(network, bits, 'ipv6');

/** Whether an address is on the public internet: not this machine, a private or link-local network, or a reserved range. */
export function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (!family) return false;
	return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

type Allow = (address: string) => boolean;

/** Resolves a name to its allowed addresses alone, so the connection can only be made to one of them. */
function guardedLookup(allow: Allow) {
	return (hostname: string, options: { family?: number | string; all?: boolean; hints?: number }, callback: (...args: unknown[]) => void) => {
		const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family) || 0;
		dnsLookup(hostname, { all: true, family, hints: options.hints }, (error, addresses: LookupAddress[]) => {
			if (error) return callback(error);
			const allowed = addresses.filter((entry) => allow(entry.address));
			if (!allowed.length) return callback(Object.assign(new Error(`${hostname} is not on the public internet`), { code: 'ENOTPUBLIC' }));
			if (options.all) callback(null, allowed);
			else callback(null, allowed[0].address, allowed[0].family);
		});
	};
}

/** Headers a page may not send: they would speak for the user, for Anton or for the connection. */
const DROPPED_REQUEST = new Set([
	'host',
	'cookie',
	'cookie2',
	'origin',
	'referer',
	'connection',
	'keep-alive',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-length',
	'accept-encoding',
	'expect',
	'via',
	'forwarded',
]);
/** Headers the page doesn't get back: cookies it couldn't keep, and the encoding Anton already undid. */
const DROPPED_RESPONSE = new Set(['set-cookie', 'set-cookie2', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

export type PageRequest = { url: string; method: string; headers: Array<[string, string]>; body: Uint8Array | null };
export type PageResponse = { status: number; statusText: string; url: string; headers: Array<[string, string]>; body: Uint8Array };

function requestHeaders(headers: Array<[string, string]>, body: Uint8Array | null): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of headers) {
		const key = name.toLowerCase();
		if (DROPPED_REQUEST.has(key) || key.startsWith('proxy-') || key.startsWith('sec-') || key.startsWith('x-forwarded-')) continue;
		out[key] = key in out ? `${out[key]}, ${value}` : value;
	}
	out['user-agent'] ??= USER_AGENT;
	out.accept ??= '*/*';
	out['accept-encoding'] = 'gzip, deflate, br';
	if (body) out['content-length'] = String(body.byteLength);
	return out;
}

function hostOf(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, '');
}

function send(url: URL, method: string, headers: Record<string, string>, body: Uint8Array | null, allow: Allow, signal: AbortSignal): Promise<IncomingMessage> {
	const host = hostOf(url);
	if (isIP(host) && !allow(host)) return Promise.reject(new PageFetchError(`${host} is not on the public internet`, 403));
	return new Promise((resolve, reject) => {
		const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers, agent: false, lookup: guardedLookup(allow) as never, signal }, resolve);
		request.on('error', (error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOTPUBLIC') reject(new PageFetchError(error.message, 403));
			else if (error.name === 'AbortError') reject(new PageFetchError(`${url.host} took longer than ${TIMEOUT_MS / 1000} seconds`, 504));
			else reject(new PageFetchError(`Couldn't reach ${url.host}: ${error.message}`));
		});
		request.end(body ?? undefined);
	});
}

/** The response's body, decoded as the browser would, up to the limit. */
async function readBody(response: IncomingMessage, limit: number): Promise<Uint8Array> {
	const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
	const decoder =
		encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
	const stream = decoder ? response.pipe(decoder) : response;
	if (decoder) response.on('error', (error) => decoder.destroy(error));
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			size += chunk.length;
			if (size > limit) throw new PageFetchError(`The response is larger than ${Math.round(limit / 1024 / 1024)} MB`);
			chunks.push(chunk);
		}
	} catch (error) {
		response.destroy();
		throw error instanceof PageFetchError ? error : new PageFetchError(`The response broke off: ${(error as Error).message}`);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

/** Read a small error explanation without letting a streaming or broken body hide its HTTP status. */
async function readErrorPrefix(response: IncomingMessage): Promise<Uint8Array> {
	const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
	const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
	const stream = decoder ?? response;
	const chunks: Buffer[] = [];
	const limit = 6000;
	let size = 0;
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			response.destroy();
			decoder?.destroy();
			resolve(new Uint8Array(Buffer.concat(chunks, size)));
		};
		const timer = setTimeout(finish, 500);
		stream.on('data', (chunk: Buffer) => {
			const part = chunk.subarray(0, limit - size);
			chunks.push(part);
			size += part.length;
			if (size >= limit) finish();
		});
		stream.on('end', finish);
		stream.on('error', finish);
		response.on('error', finish);
		response.on('close', () => { if (!response.complete) finish(); });
		if (decoder) response.pipe(decoder);
	});
}

/**
 * Makes a page's request from Anton, following redirects as a browser would.
 * `allow` decides which addresses it may connect to; tests widen it to this machine.
 * Preview checks need status and headers, not a whole body; read only a bounded error prefix.
 */
export async function fetchForPage(
	request: PageRequest,
	{ allow = isPublicAddress, timeoutMs = TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES, responseMode = 'full' }: { allow?: Allow; timeoutMs?: number; maxBytes?: number; responseMode?: 'full' | 'preview' } = {},
): Promise<PageResponse> {
	let url = parseUrl(request.url);
	let method = request.method;
	let body = request.body;
	let headers = requestHeaders(request.headers, body);
	const signal = AbortSignal.timeout(timeoutMs);
	for (let hop = 0; ; hop++) {
		const response = await send(url, method, headers, body, allow, signal);
		const status = response.statusCode ?? 0;
		const location = response.headers.location;
		if ([301, 302, 303, 307, 308].includes(status) && location) {
			if (responseMode === 'preview') response.destroy();
			else response.resume();
			if (hop >= MAX_REDIRECTS) throw new PageFetchError(`${request.url} redirected more than ${MAX_REDIRECTS} times`);
			const next = parseUrl(new URL(location, url).href);
			if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
				if (method !== 'HEAD') method = 'GET';
				body = null;
				const { 'content-type': _type, 'content-length': _length, ...rest } = headers;
				headers = rest;
			}
			// Credentials meant for one site don't follow a redirect to another.
			if (next.origin !== url.origin) delete headers.authorization;
			url = next;
			continue;
		}
		let bytes: Uint8Array;
		if (responseMode === 'preview') {
			if (method !== 'HEAD' && status >= 400) bytes = await readErrorPrefix(response);
			else {
				response.destroy();
				bytes = new Uint8Array();
			}
		} else bytes = method === 'HEAD' ? new Uint8Array() : await readBody(response, maxBytes);
		const out: Array<[string, string]> = [];
		for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
			const name = response.rawHeaders[i];
			if (!DROPPED_RESPONSE.has(name.toLowerCase())) out.push([name, response.rawHeaders[i + 1]]);
		}
		return { status, statusText: response.statusMessage ?? '', url: url.href, headers: out, body: bytes };
	}
}

function parseUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new InvalidInputError(`Not a URL: ${value.slice(0, 200)}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new InvalidInputError(`A page can call http and https addresses only, not ${url.protocol}`);
	if (url.username || url.password) throw new InvalidInputError('Put credentials in a header, not in the URL.');
	return url;
}

/** What the frame page sends: the request, its body in base64. */
function checkRequest(input: unknown): PageRequest {
	const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
	if (typeof value.url !== 'string' || value.url.length > 8192) throw new InvalidInputError('A request needs a URL.');
	const method = typeof value.method === 'string' ? value.method.toUpperCase() : 'GET';
	if (!METHODS.has(method)) throw new InvalidInputError(`A page can't send ${method.slice(0, 20)} requests.`);
	const headers: Array<[string, string]> = [];
	if (value.headers !== undefined && value.headers !== null) {
		if (!Array.isArray(value.headers) || value.headers.length > 64) throw new InvalidInputError('Headers are a list of up to 64 pairs.');
		for (const pair of value.headers) {
			if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/i.test(pair[0]) || pair[1].length > 8192 || /[\r\n\0]/.test(pair[1]))
				throw new InvalidInputError('Each header is a name and a value.');
			headers.push([pair[0], pair[1]]);
		}
	}
	let body: Uint8Array | null = null;
	if (typeof value.body === 'string' && value.body) {
		if (value.body.length > Math.ceil(MAX_REQUEST_BYTES / 3) * 4) throw new InvalidInputError(`A page sends up to ${MAX_REQUEST_BYTES / 1024 / 1024} MB.`);
		body = new Uint8Array(Buffer.from(value.body, 'base64'));
	}
	if (body && (method === 'GET' || method === 'HEAD')) throw new InvalidInputError(`A ${method} request has no body.`);
	return { url: value.url, method, headers, body };
}

const running = new Map<string, number>();

/** A page's request, made for it: the task's page, with Pages reach the web on, a few at a time. Its body comes back in base64. */
export async function pageFetch(id: string, path: string, input: unknown) {
	if (!isRenderPath(path)) throw new NotFoundError('Not a page');
	if (!(await getSessionRecord(id))) throw new NotFoundError('Session not found');
	if (!(await generalSettings()).pageNetwork) throw new PageFetchError('Pages reach the web is off in Settings › General.', 403);
	const request = checkRequest(input);
	const now = running.get(id) ?? 0;
	if (now >= MAX_AT_ONCE) throw new PageFetchError(`A task's pages make up to ${MAX_AT_ONCE} requests at once.`, 429);
	running.set(id, now + 1);
	try {
		const response = await fetchForPage(request);
		return { ...response, body: Buffer.from(response.body).toString('base64') };
	} finally {
		const left = (running.get(id) ?? 1) - 1;
		if (left > 0) running.set(id, left);
		else running.delete(id);
	}
}
