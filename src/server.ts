import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { site } from './core/site.ts';
import { routeUpgrades } from './core/upgrades.ts';
import { servePreviews } from './core/preview-proxy.ts';

const { loadFlueNodeApplication } = (await import(new URL('../dist/app.mjs', import.meta.url).href)) as {
	loadFlueNodeApplication: () => Promise<{ fetch: (request: Request) => Response | Promise<Response>; stop: () => Promise<void> }>;
};
const application = await loadFlueNodeApplication();
const port = Number(process.env.PORT ?? 3000);
/** Every interface unless set; `127.0.0.1` keeps Anton off the local network when a tunnel on this machine is its only way in. */
const hostname = process.env.HOST?.trim() || undefined;
/**
 * Longer than the proxy in front keeps an idle connection (cloudflared 90 s, Cloudflare's edge 900 s), so the proxy
 * always closes first. Node's 5 s default closes connections the proxy still means to reuse, and a request sent on
 * one fails or waits on a fresh connection.
 */
const KEEP_ALIVE_MS = 910_000;

const app = site((request) => application.fetch(request), './dist/client');

const server = serve({ fetch: app.fetch, port, hostname, serverOptions: { requestTimeout: 0 } }, () =>
	console.log(`[anton] listening on http://${hostname ?? 'localhost'}:${port}`),
);
(server as Server).keepAliveTimeout = KEEP_ALIVE_MS;
// Before the socket routes, so a preview's sockets (Vite's live reload) reach its dev server.
servePreviews(server as Server, port);
routeUpgrades(server as Server, '/vm/');

async function shutdown(code: number): Promise<void> {
	server.close();
	await application.stop();
	process.exit(code);
}
process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));
