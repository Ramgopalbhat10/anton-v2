import type { Context } from 'hono';
import * as v from 'valibot';
import { InvalidInputError } from '../core/errors.ts';
import { REASONING_LEVELS } from '../core/ports.ts';
import { ROUTE_SORTS } from '../core/model-route.ts';

export const REASONING = v.picklist(REASONING_LEVELS);
/** One provider first (by the gateway's slug), or a sort; null leaves it to the gateway. */
export const ROUTE = v.nullable(
	v.union([v.object({ provider: v.pipe(v.string(), v.regex(/^[\w.\-/:]{1,80}$/)) }), v.object({ sort: v.picklist(ROUTE_SORTS) })]),
);
export const AGENT_MODEL = v.nullable(v.object({ model: v.pipe(v.string(), v.minLength(1)), reasoning: v.nullable(REASONING) }));
/** Variables from the browser; null keeps a stored value. */
export const ENV = v.pipe(
	v.record(v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Variable names use letters, digits and underscores')), v.nullable(v.string())),
	v.check((env) => Object.keys(env).length <= 100, 'At most 100 variables'),
);

export function valid<T extends v.GenericSchema>(schema: T, value: unknown): v.InferOutput<T> {
	const result = v.safeParse(schema, value);
	if (!result.success) throw new InvalidInputError(result.issues.map((issue) => issue.message).join('; '));
	return result.output;
}

export async function body<T extends v.GenericSchema>(c: Context, schema: T): Promise<v.InferOutput<T>> {
	return valid(schema, await c.req.json().catch(() => ({})));
}

// Everything else downloads, so agent-written HTML never runs on this origin; the browser's PDF viewer keeps a PDF's scripts away.
const INLINE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	svg: 'image/svg+xml',
	pdf: 'application/pdf',
};
export const contentType = (path: string) => INLINE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

// An opened SVG could run script on Anton's origin; served sandboxed it only draws.
const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export function bytes(c: Context, data: Uint8Array | null, type = 'application/octet-stream') {
	if (!data) return c.json({ error: 'Not found' }, 404);
	return c.body(data as Uint8Array<ArrayBuffer>, 200, {
		'Content-Type': type,
		'X-Content-Type-Options': 'nosniff',
		...(type === 'image/svg+xml' ? { 'Content-Security-Policy': SVG_CSP } : {}),
	});
}
