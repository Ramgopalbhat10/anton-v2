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
			const slug = source.pathname.split('/').filter(Boolean).at(-1)!;
			const metaResponse = await bounded(`https://www.nasa.gov/wp-json/wp/v2/media?slug=${encodeURIComponent(slug)}`, 1024 * 1024, /^application\/json$/);
			const metadata = JSON.parse(Buffer.from(metaResponse.body).toString('utf8'));
			const media = Array.isArray(metadata) ? metadata.find((entry) => entry?.link === source.href && entry?.source_url === original.href) : null;
			if (!media || typeof media.credits !== 'string' || media.credits.length > 500) throw new Error('Missing credits');
			const credit = text(media.credits);
			const licenseUrl = imageLicense(credit, `${title} ${field('description')} ${text(media.description?.rendered ?? '')}`);
			if (!licenseUrl || media.media_details?.image_meta?.copyright) throw new Error('Unverified rights');
			if (cached?.sourceUrl === source.href) {
				cached = { ...cached, title, credit, licenseUrl };
			} else {
				// NASA's WordPress image service returns a bounded 960px rendition, not the original.
				original.search = '?w=960';
				const image = await bounded(original, 2 * 1024 * 1024, /^image\/(?:jpeg|png|webp)$/);
				if (!image.body.length) throw new Error('Empty image');
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
