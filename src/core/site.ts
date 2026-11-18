import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';

/** Vite names every built file under `/assets/` by its content hash, so a name never comes back with different bytes. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** The page, the service worker and the manifest name the current build's assets, so they are checked on every load. */
const REVALIDATE = 'no-cache';

/**
 * The production site: the API, then the built UI. Responses are gzipped here because a Cloudflare tunnel carries
 * whatever bytes the origin sends; Cloudflare re-encodes for the browser but not for the tunnel. Hono's `compress`
 * skips `text/event-stream`, so the change stream and Flue's SSE still flush each event; a long poll answers in one body.
 */
export function site(api: (request: Request) => Response | Promise<Response>, clientRoot: string): Hono {
	const app = new Hono();
	app.use('*', compress());
	app.all('/api/*', (c) => api(c.req.raw));
	app.use('/assets/*', cached(serveStatic({ root: clientRoot }), IMMUTABLE));
	// A tab still on an earlier build asks for assets this build lacks: a plain 404, not the page answering as a script.
	app.get('/assets/*', (c) => c.text('Not found', 404, { 'Cache-Control': 'no-store' }));
	app.use('/*', cached(serveStatic({ root: clientRoot }), REVALIDATE));
	app.get('/*', cached(serveStatic({ path: join(clientRoot, 'index.html') }), REVALIDATE));
	return app;
}

/** `serveStatic`'s `onFound` runs after the response is made, too late for a header. */
function cached(serve: MiddlewareHandler, cacheControl: string): MiddlewareHandler {
	return async (c, next) => {
		let served = true;
		const response = await serve(c, async () => {
			served = false;
			await next();
		});
		if (served && response instanceof Response && response.status < 300) response.headers.set('Cache-Control', cacheControl);
		return response;
	};
}
