import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * Previews of tasks that run on this server. A dev server there listens on this machine's own ports, which only a
 * browser on this machine reaches as `localhost`; behind a tunnel, Anton serves each preview port on a hostname of
 * its own instead, named by `ANTON_PREVIEW_URL` (such as `https://preview-{port}.example.com`), and passes its
 * requests and sockets to `127.0.0.1:<port>`.
 *
 * A hostname per port, not a path under Anton's own: dev servers load from absolute paths (Vite's `/@vite/client`),
 * and agent-run code on its own origin cannot call Anton's API with the owner's cookies. Nothing new is reachable
 * from outside: the hostnames go through the same tunnel and access proxy as Anton (SECURITY_MODEL.md), and only the
 * ports projects name for previews are served, never Anton's own.
 */
export const PREVIEW_URL_ENV = 'ANTON_PREVIEW_URL';

/** The template from the environment, when it is a URL with `{port}` in its hostname. */
export function previewTemplate(value = process.env[PREVIEW_URL_ENV]): string | null {
	const template = value?.trim();
	if (!template || !template.includes('{port}')) return null;
	try {
		return new URL(template.replace('{port}', '1')).protocol.startsWith('http') && hostOf(template).includes('{port}') ? template.replace(/\/+$/, '') : null;
	} catch {
		return null;
	}
}

const hostOf = (template: string) => template.replace(/^[a-z]+:\/\//i, '').split('/')[0]!;

/** Where the browser opens `port`; null when previews are not served here. */
export function previewAddress(port: number, template = previewTemplate()): string | null {
	return template ? template.replace('{port}', String(port)) : null;
}

/** The port a request's Host names, or null for any other host (Anton's own pages and API). */
export function previewPortOf(host: string | undefined, template = previewTemplate()): number | null {
	if (!host || !template) return null;
	const escaped = hostOf(template)
		.toLowerCase()
		.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		.replace('\\{port\\}', '(\\d{2,5})');
	const match = new RegExp(`^${escaped}$`).exec(host.toLowerCase().replace(/:\d+$/, ''));
	const port = match ? Number(match[1]) : NaN;
	return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/** Which ports may be served: the app publishes it, as this server is loaded outside the app's module graph. */
type PortCheck = (port: number) => boolean | Promise<boolean>;
const SLOT = Symbol.for('anton.preview-ports');
const slot = globalThis as { [SLOT]?: PortCheck };

export function publishPreviewPorts(check: PortCheck): void {
	slot[SLOT] = check;
}

async function allowed(port: number, ownPort: number): Promise<boolean> {
	if (port === ownPort) return false;
	const check = slot[SLOT];
	return check ? Boolean(await check(port)) : false;
}

const notServed = (port: number) =>
	`Nothing is being previewed on port ${port}. Start the dev server on one of the task's preview ports ($ANTON_PREVIEW_PORTS), bound to 0.0.0.0.`;

/**
 * Routes requests and WebSocket upgrades whose Host names a preview port to that port on this machine; everything
 * else goes to Anton as before. Does nothing unless `ANTON_PREVIEW_URL` is set.
 */
export function servePreviews(server: Server, ownPort: number, template = previewTemplate()): void {
	if (!template) return;
	const app = server.listeners('request') as ((request: IncomingMessage, response: ServerResponse) => void)[];
	server.removeAllListeners('request');
	server.on('request', (request: IncomingMessage, response: ServerResponse) => {
		const port = previewPortOf(request.headers.host, template);
		if (port === null) {
			for (const listener of app) listener.call(server, request, response);
			return;
		}
		void proxyRequest(request, response, port, ownPort);
	});
	server.prependListener('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		const port = previewPortOf(request.headers.host, template);
		if (port === null) return;
		// Marked, so Anton's own socket routes leave it alone.
		(request as IncomingMessage & { preview?: true }).preview = true;
		void proxyUpgrade(request, socket, head, port, ownPort);
	});
}

export const isPreviewUpgrade = (request: IncomingMessage) => (request as IncomingMessage & { preview?: true }).preview === true;

async function proxyRequest(request: IncomingMessage, response: ServerResponse, port: number, ownPort: number): Promise<void> {
	if (!(await allowed(port, ownPort))) {
		response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(notServed(port));
		return;
	}
	// The Host stays the browser's: dev servers that check it (Vite) are told of the preview hostnames.
	const upstream = httpRequest({ host: '127.0.0.1', port, method: request.method, path: request.url, headers: request.headers }, (reply) => {
		response.writeHead(reply.statusCode ?? 502, reply.statusMessage, reply.headers);
		reply.pipe(response);
	});
	upstream.on('error', () => {
		if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
		response.end(notServed(port));
	});
	// A browser that went away mid-response stops the dev server's side too.
	response.on('close', () => {
		if (!response.writableFinished) upstream.destroy();
	});
	request.pipe(upstream);
}

async function proxyUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, port: number, ownPort: number): Promise<void> {
	socket.on('error', () => undefined);
	if (!(await allowed(port, ownPort))) {
		socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
		return;
	}
	const upstream = connect(port, '127.0.0.1', () => {
		const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
		for (let index = 0; index < request.rawHeaders.length; index += 2) lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
		upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
		if (head.length) upstream.write(head);
		upstream.pipe(socket);
		socket.pipe(upstream);
	});
	// Either side ending ends both: a dev server's socket is half-open otherwise, and both would stay open for good.
	const end = () => {
		upstream.destroy();
		socket.destroy();
	};
	upstream.on('error', end).on('end', end).on('close', end);
	socket.on('end', end).on('close', end);
}
