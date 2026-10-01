import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { attachTerminal } from './services/terminal.ts';

/**
 * Production entry: the built Flue application, the built UI, and the
 * terminal WebSocket on one port. Run `npm run build` first.
 */
const { loadFlueNodeApplication } = (await import(new URL('../dist/app.mjs', import.meta.url).href)) as {
	loadFlueNodeApplication: () => Promise<{ fetch: (request: Request) => Response | Promise<Response>; stop: () => Promise<void> }>;
};
const application = await loadFlueNodeApplication();
const port = Number(process.env.PORT ?? 3000);

const site = new Hono();
site.all('/api/*', (c) => application.fetch(c.req.raw));
site.use('/*', serveStatic({ root: './dist/client' }));
site.get('/*', serveStatic({ path: './dist/client/index.html' }));

const server = serve({ fetch: site.fetch, port, serverOptions: { requestTimeout: 0 } }, () =>
	console.log(`[anton] listening on http://localhost:${port}`),
);
attachTerminal(server as Server);

async function shutdown(code: number): Promise<void> {
	server.close();
	await application.stop();
	process.exit(code);
}
process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));
