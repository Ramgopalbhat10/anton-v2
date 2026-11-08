import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nasaDailyImage, NASA_DAILY_FEED, DAY_MS, imageLicense, isSmallStaticRaster, nextDailyRefresh } from '../src/providers/nasa/daily-image.ts';
import { scienceBackgroundApi } from '../src/api/science-background.ts';

// A minimal SOF header is enough to exercise our dimensions guard; browser decode is checked separately.
const jpeg = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 2, 28, 3, 192, 1]);
const source = 'https://www.nasa.gov/image-detail/nebula/';
const original = 'https://www.nasa.gov/wp-content/uploads/2026/11/nebula.jpg';
const item = (options: { source?: string; image?: string; type?: string } = {}) => `<rss><channel><item><title>Nebula &amp; stars</title><link>${options.source ?? source}</link><description>A beautiful nebula.</description><pubDate>Fri, 06 Nov 2026 16:28 GMT</pubDate><enclosure url="${options.image ?? original}" type="${options.type ?? 'image/jpeg'}" /></item></channel></rss>`;
const meta = (credit = 'NASA') => `<html><meta property="og:image" content="${original}"><meta property="og:image:alt" content="A nebula"><div class="hds-attachment-single__credit color-carbon-30">Image Credit: ${credit}</div></html>`;
function fixture() {
	let now = Date.parse('2026-11-08T12:00:00Z');
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	let feed = item();
	let metadata: unknown = meta();
	let failure = '';
	const request = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input); calls.push({ url, init });
		if (failure === 'network') throw new Error('Offline');
		if (failure === 'http') return new Response('', { status: 503 });
		if (url === NASA_DAILY_FEED) return new Response(feed, { headers: { 'content-type': 'application/rss+xml' } });
		if (url === source) return new Response(String(metadata), { headers: { 'content-type': 'text/html' } });
		return new Response(failure === 'oversize' ? new Uint8Array(2 * 1024 * 1024 + 1) : jpeg, { headers: { 'content-type': failure === 'mime' ? 'text/html' : 'image/jpeg' } });
	}) as typeof fetch;
	return { provider: nasaDailyImage({ fetch: request, now: () => now }), calls, day: () => { now = nextDailyRefresh(now); }, advance: (ms: number) => { now += ms; }, setFeed: (value: string) => { feed = value; }, setMeta: (value: unknown) => { metadata = value; }, fail: (value: string) => { failure = value; } };
}

test('NASA daily image fetches the official no-key feed, full credits and a bounded rendition once a day', async () => {
	const f = fixture();
	const image = await f.provider.current();
	assert.ok(image);
	assert.equal(image.title, 'Nebula & stars'); assert.equal(image.credit, 'NASA'); assert.equal(image.date, '2026-11-06');
	assert.equal(image.sourceUrl, source); assert.equal(image.bytes.length, jpeg.length);
	assert.deepEqual(f.calls.map(c => c.url), [NASA_DAILY_FEED, source, `${original}?w=960`]);
	assert.ok(f.calls.every(c => c.init?.redirect === 'error' && c.init.signal));
	assert.equal(await f.provider.current(), image); assert.equal(f.calls.length, 3);
	f.day(); await f.provider.current(); assert.equal(f.calls.length, 5, 'same published image keeps bytes; does not invent a new image on weekends');
});

test('concurrent daily requests share one in-flight fetch', async () => {
	const f = fixture(); const images = await Promise.all(Array.from({ length: 10 }, () => f.provider.current()));
	assert.equal(f.calls.length, 3); assert.ok(images.every(i => i === images[0]));
});

test('next daily refresh is midnight UTC, not one hour or 24 hours after mount', () => {
	assert.equal(nextDailyRefresh(0), DAY_MS); assert.equal(nextDailyRefresh(DAY_MS - 1), DAY_MS);
	assert.equal(nextDailyRefresh(DAY_MS + 1), DAY_MS * 2);
});

test('fresh failures return fallback with cooldown; previous good images survive a daily outage', async () => {
	const cold = fixture(); cold.fail('network'); assert.equal(await cold.provider.current(), null); await cold.provider.current(); assert.equal(cold.calls.length, 1);
	cold.advance(30 * 60_000); cold.fail(''); assert.ok(await cold.provider.current());
	const warm = fixture(); const image = await warm.provider.current(); warm.day(); warm.fail('http'); assert.equal(await warm.provider.current(), image);
});

test('malformed feeds, declarations, videos and unsafe URLs fail closed without image requests', async () => {
	for (const feed of ['not xml', '<rss/>', '<!DOCTYPE x>'+item(), item({ type: 'video/mp4' }), item({ source: 'https://evil.test/image-detail/nebula/' }), item({ image: 'http://127.0.0.1/nebula.jpg' }), item({ image: 'https://www.nasa.gov.evil.test/wp-content/uploads/2026/11/nebula.jpg' })]) {
		const f = fixture(); f.setFeed(feed); assert.equal(await f.provider.current(), null); assert.equal(f.calls.length, 1);
	}
});

test('missing, mismatched, restricted and unknown credits do not download an image', async () => {
	for (const metadata of ['', 'not a source page', meta().replace(original, 'https://evil.test/'), ...['', 'Getty Images', 'NASA, courtesy of SpaceX', 'NASA © 2026', 'An independent photographer', 'NASA, Unknown Agency'].map(c => meta(c))]) {
		const f = fixture(); f.setMeta(metadata); assert.equal(await f.provider.current(), null); assert.equal(f.calls.length, 2);
	}
});

test('rights policy preserves known joint Hubble/Webb terms and excludes people or restrictions', () => {
	assert.equal(imageLicense('ESA/Hubble & NASA, M. Libralato, G. Piotto, A. Sarajedini', 'A star cluster'), 'https://esahubble.org/copyright/');
	assert.equal(imageLicense('NASA, ESA, CSA, STScI', 'Cosmic cliffs'), 'https://webbtelescope.org/copyright');
	assert.equal(imageLicense('NASA', 'An astronaut during a spacewalk'), null);
	assert.equal(imageLicense('NASA', 'A portrait of crew members'), null);
	assert.equal(imageLicense('NASA / CC-BY-NC', 'A nebula'), null);
});

test('oversized streamed images and incorrect media types use fallback', async () => {
	for (const failure of ['oversize', 'mime']) { const f = fixture(); f.fail(failure); assert.equal(await f.provider.current(), null); }
});

test('image headers bound decoded memory and reject animated PNG/WebP and mismatched bytes', () => {
	assert.equal(isSmallStaticRaster(jpeg, 'image/jpeg'), true);
	assert.equal(isSmallStaticRaster(jpeg, 'image/png'), false);
	assert.equal(isSmallStaticRaster(new Uint8Array([1, 2]), 'image/jpeg'), false);
	const huge = Buffer.from(jpeg); huge.writeUInt16BE(10_000, 7);
	assert.equal(isSmallStaticRaster(huge, 'image/jpeg'), false);
	const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBPVP8X', 8); webp.writeUIntLE(959, 24, 3); webp.writeUIntLE(539, 27, 3);
	assert.equal(isSmallStaticRaster(webp, 'image/webp'), true); webp[20] = 2;
	assert.equal(isSmallStaticRaster(webp, 'image/webp'), false);
	const png = Buffer.alloc(53); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(960, 16); png.writeUInt32BE(540, 20); png.writeUInt32BE(8, 33); png.write('acTL', 37);
	assert.equal(isSmallStaticRaster(png, 'image/png'), false);
});

test('request timeout/abort is caught and has a cooldown', async () => {
	let calls = 0;
	const provider = nasaDailyImage({ fetch: (async (_url, init) => { calls++; assert.ok(init?.signal); throw new DOMException('Timeout', 'TimeoutError'); }) as typeof fetch });
	assert.equal(await provider.current(), null); assert.equal(await provider.current(), null); assert.equal(calls, 1);
});

test('API serves metadata without bytes and only the current hashed image, never caller-supplied URLs', async () => {
	const f = fixture(); const api = scienceBackgroundApi(() => f.provider);
	const response = await api.request('/api/science-background?url=https://evil.test/');
	assert.equal(response.status, 200); const { image } = await response.json() as { image: { title: string; bytes?: unknown; url: string } };
	assert.equal(image.title, 'Nebula & stars'); assert.equal(image.bytes, undefined); assert.match(image.url, /^\/api\/science-background\/image\?id=[a-f0-9]{16}$/);
	const photo = await api.request(image.url); assert.equal(photo.status, 200); assert.equal(photo.headers.get('Content-Type'), 'image/jpeg'); assert.equal(photo.headers.get('X-Content-Type-Options'), 'nosniff'); assert.equal((await photo.arrayBuffer()).byteLength, jpeg.length);
	assert.equal((await api.request('/api/science-background/image?id=old')).status, 404);
	assert.ok(f.calls.every(c => c.url.startsWith('https://www.nasa.gov/')));
	assert.deepEqual(await (await scienceBackgroundApi(() => null).request('/api/science-background')).json(), { image: null });
});
