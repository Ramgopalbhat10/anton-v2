import { Hono } from 'hono';
import type { DailyScienceImageProvider } from '../core/ports.ts';

/** Fixed-purpose metadata/image endpoints: callers cannot supply a remote URL. */
export function scienceBackgroundApi(provider: () => DailyScienceImageProvider | null | undefined) {
	return new Hono()
		.get('/api/science-background', async (c) => {
			const image = await provider()?.current();
			c.header('Cache-Control', 'no-store');
			if (!image) return c.json({ image: null });
			const { id, title, date, credit, sourceUrl, licenseUrl } = image;
			return c.json({ image: { url: `/api/science-background/image?id=${id}`, title, date, credit, sourceUrl, licenseUrl } });
		})
		.get('/api/science-background/image', async (c) => {
			const image = await provider()?.current();
			if (!image || c.req.query('id') !== image.id) return c.notFound();
			c.header('Content-Type', image.contentType);
			c.header('Cache-Control', 'public, max-age=86400, immutable');
			c.header('X-Content-Type-Options', 'nosniff');
			return c.body(Buffer.from(image.bytes));
		});
}
