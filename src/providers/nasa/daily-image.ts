import { createHash } from 'node:crypto';
import type { DailyScienceImage, DailyScienceImageProvider } from '../../core/ports.ts';

export const NASA_DAILY_FEED = 'https://www.nasa.gov/feeds/iotd-feed/';
export const DAY_MS = 86_400_000;
const NASA_POLICY = 'https://www.nasa.gov/nasa-brand-center/images-and-media/';
const HUBBLE_POLICY = 'https://esahubble.org/copyright/';
const WEBB_POLICY = 'https://webbtelescope.org/copyright';

export function nextDailyRefresh(now: number): number {
	return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}

function text(value: string): string {
	return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
		if (entity.startsWith('#')) {
			const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
		}
		return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()];
	}).trim();
}

function nasaUrl(value: unknown, path: RegExp): URL {
	if (typeof value !== 'string') throw new Error('Missing NASA URL');
	const url = new URL(value);
	if (url.origin !== 'https://www.nasa.gov' || url.username || url.password || !path.test(url.pathname)) throw new Error('Unsafe NASA URL');
	return url;
}

/** Fail closed on unknown rights, restrictive marks and identifiable people in the caption. */
export function imageLicense(credit: string, description: string): string | null {
	if (/copyright|©|courtesy|all rights|CC[ -]?BY|Getty|Reuters|SpaceX|Adobe|Shutterstock/i.test(credit) || /\b(astronaut|crew|portrait|selfie|people|person|employee|engineer|scientist|technician|team members)\b/i.test(description)) return null;
	if (/^ESA\/Hubble\s*(?:&|and)\s*NASA(?:, [\p{L}\p{N} .,'()&/–-]+)?$/u.test(credit)) return HUBBLE_POLICY;
	if (/^NASA, ESA, CSA, STScI$/.test(credit)) return WEBB_POLICY;
	if (/^NASA(?:['’]s Earth Observatory|\/(?:[\p{L} .'-]+|JPL-Caltech))?$/u.test(credit)) return NASA_POLICY;
	return null;
}

/** Validate decoded size and reject animated PNG/WebP before retaining bytes. No image decoder needed. */
export function isSmallStaticRaster(bytes: Uint8Array, type: string): boolean {
	const b = Buffer.from(bytes);
	let width = 0;
	let height = 0;
	if (type === 'image/png' && b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.toString('ascii', 12, 16) === 'IHDR') {
		width = b.readUInt32BE(16); height = b.readUInt32BE(20);
		for (let offset = 8; offset + 12 <= b.length;) {
			const length = b.readUInt32BE(offset);
			if (b.toString('ascii', offset + 4, offset + 8) === 'acTL') return false;
			offset += length + 12;
			if (offset > b.length) return false;
		}
	} else if (type === 'image/webp' && b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
		const format = b.toString('ascii', 12, 16);
		if (format === 'VP8X') {
			if (b[20] & 2) return false; // ANIMATION_FLAG
			width = b.readUIntLE(24, 3) + 1; height = b.readUIntLE(27, 3) + 1;
		} else if (format === 'VP8 ' && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) {
			width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff;
		} else if (format === 'VP8L' && b[20] === 0x2f) {
			width = (b.readUInt32LE(21) & 0x3fff) + 1;
			height = ((b.readUInt32LE(21) >>> 14) & 0x3fff) + 1;
		}
	} else if (type === 'image/jpeg' && b[0] === 0xff && b[1] === 0xd8) {
		for (let offset = 2; offset + 4 <= b.length;) {
			if (b[offset] !== 0xff) return false;
			const marker = b[offset + 1];
			const length = b.readUInt16BE(offset + 2);
			if (length < 2 || offset + 2 + length > b.length) return false;
			if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
				height = b.readUInt16BE(offset + 5); width = b.readUInt16BE(offset + 7); break;
			}
			offset += length + 2;
		}
	}
	return width > 0 && width <= 1024 && height > 0 && height <= 2048 && width * height <= 2_000_000;
}

/** One <=2MiB still per process, one in-flight refresh; no API key, disk archive or background polling. */
export function nasaDailyImage(options: { fetch?: typeof fetch; now?: () => number } = {}): DailyScienceImageProvider {
	const request = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	let cached: DailyScienceImage | null = null;
	let refreshAt = 0;
	let pending: Promise<DailyScienceImage | null> | undefined;

	async function update(): Promise<DailyScienceImage | null> {
		// One deadline covers feed, metadata and image, including streamed bodies.
		const signal = AbortSignal.timeout(12_000);
		async function bounded(url: URL | string, max: number, expected: RegExp): Promise<{ body: Uint8Array; type: string }> {
			const response = await request(url, { signal, redirect: 'error', headers: { Accept: 'application/rss+xml, application/json, image/jpeg, image/png, image/webp' } });
			const type = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
			if (!response.ok || !expected.test(type) || Number(response.headers.get('content-length') ?? 0) > max) {
				await response.body?.cancel();
				throw new Error('Unsupported NASA response');
			}
			const reader = response.body?.getReader();
			if (!reader) throw new Error('Empty NASA response');
			const parts: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					size += value.length;
					if (size > max) throw new Error('NASA response too large');
					parts.push(value);
				}
			} finally {
				await reader.cancel();
			}
			return { body: Buffer.concat(parts), type };
		}
		try {
			const feed = await bounded(NASA_DAILY_FEED, 512 * 1024, /^(?:text\/xml|application\/(?:rss\+xml|xml))$/);
			const xml = Buffer.from(feed.body).toString('utf8');
			// This deliberately small RSS reader handles only NASA's bounded, flat item fields;
			// it never expands XML entities, DTDs, HTML or external resources.
			if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unexpected RSS declaration');
			const item = xml.match(/<item\b[^>]*>([\s\S]*?)<\/item>/)?.[1];
			if (!item) throw new Error('No daily image');
			const field = (name: string) => text(item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`))?.[1] ?? '');
			const source = nasaUrl(field('link'), /^\/image-detail\/[a-zA-Z0-9-]+\/$/);
			const title = field('title').slice(0, 240);
			const published = Date.parse(field('pubDate'));
			if (!title || !Number.isFinite(published) || published > now() + DAY_MS) throw new Error('Invalid publication');
			const enclosure = item.match(/<enclosure\b[^>]*>/)?.[0] ?? '';
			const original = nasaUrl(text(enclosure.match(/\burl="([^"]+)"/)?.[1] ?? ''), /^\/wp-content\/uploads\/\d{4}\/\d{2}\/[\w.-]+\.(?:jpg|jpeg|png|webp)$/i);
			if (!/\btype="image\/(?:jpeg|png|webp)"/.test(enclosure)) throw new Error('Not a still image');
			// The public source page includes the authoritative credit and image alt text.
			// Avoid the WordPress REST API, which NASA may block independently of its pages/feed.
			const page = await bounded(source, 1024 * 1024, /^text\/html$/);
			const html = Buffer.from(page.body).toString('utf8');
			const meta = (property: string) => {
				const tag = (html.match(/<meta\b[^>]*>/g) ?? []).find((tag) => tag.includes(`property="${property}"`));
				return text(tag?.match(/\bcontent="([^"]*)"/)?.[1] ?? '');
			};
			if (meta('og:image') !== original.href) throw new Error('Mismatched image metadata');
			const credit = text(html.match(/<div\b[^>]*class="[^"]*\bhds-attachment-single__credit\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '').replace(/^Image Credit:\s*/i, '');
			if (!credit || credit.length > 500) throw new Error('Missing credits');
			const licenseUrl = imageLicense(credit, `${title} ${field('description')} ${meta('og:description')} ${meta('og:image:alt')}`);
			if (!licenseUrl) throw new Error('Unverified rights');
			if (cached?.sourceUrl === source.href) {
				cached = { ...cached, title, credit, licenseUrl };
			} else {
				// NASA's WordPress image service returns a bounded 960px rendition, not the original.
				original.search = '?w=960';
				const image = await bounded(original, 2 * 1024 * 1024, /^image\/(?:jpeg|png|webp)$/);
				if (!isSmallStaticRaster(image.body, image.type)) throw new Error('Not a small static image');
				const id = createHash('sha256').update(image.body).digest('hex').slice(0, 16);
				cached = { id, title, credit, licenseUrl, date: new Date(published).toISOString().slice(0, 10), sourceUrl: source.href, bytes: image.body, contentType: image.type as DailyScienceImage['contentType'] };
			}
			refreshAt = nextDailyRefresh(now());
		} catch {
			// Retain the last usable image; a cold server returns null for the bundled fallback.
			refreshAt = now() + 30 * 60_000;
		}
		return cached;
	}
	return {
		async current() {
			if (now() < refreshAt) return cached;
			pending ??= update().finally(() => { pending = undefined; });
			return pending;
		},
	};
}
