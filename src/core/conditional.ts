import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/** A browser keeps the answer and asks again on each read, sending its tag; nothing is cached as fresh. */
const REVALIDATE = 'private, no-cache';

/** `If-None-Match` lists tags, weak or strong; Cloudflare turns a strong tag weak when it re-encodes the body. */
export function tagMatches(header: string | undefined, tag: string): boolean {
	if (!header) return false;
	const bare = (value: string) => value.trim().replace(/^W\//, '');
	return header.split(',').some((value) => value.trim() === '*' || bare(value) === bare(tag));
}

/**
 * Tags every JSON read with a hash of its body, and answers a read whose tag the browser already holds with an empty
 * 304, which the browser fills from its copy. The tag is the body itself, so an answer can never be taken for an older one.
 * Streams, other types, answers that may not be stored and answers that set cookies are passed through as they are.
 */
export function conditionalJson(): MiddlewareHandler {
	return async (c, next) => {
		await next();
		if (c.req.method !== 'GET' || c.res.status !== 200) return;
		const response = c.res;
		const headers = response.headers;
		if (!headers.get('content-type')?.toLowerCase().startsWith('application/json')) return;
		if (headers.has('etag') || headers.has('set-cookie') || /no-store/i.test(headers.get('cache-control') ?? '')) return;
		const body = new Uint8Array(await response.arrayBuffer());
		const tag = `W/"${createHash('sha1').update(body).digest('base64url')}"`;
		const cacheControl = headers.get('cache-control') ?? REVALIDATE;
		if (tagMatches(c.req.header('if-none-match'), tag)) {
			c.res = new Response(null, { status: 304, headers: { ETag: tag, 'Cache-Control': cacheControl } });
			return;
		}
		const kept = new Headers(headers);
		kept.set('ETag', tag);
		kept.set('Cache-Control', cacheControl);
		kept.delete('content-length');
		c.res = new Response(body, { status: 200, statusText: response.statusText, headers: kept });
	};
}
