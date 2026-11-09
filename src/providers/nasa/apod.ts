import type { DailyPicture, DailyPictureInfo } from '../../core/ports.ts';

/*
 * NASA's Astronomy Picture of the Day. The day's entry is read from the
 * APOD feed on science.nasa.gov, which names the picture and its credit and
 * links its image on NASA's image service (which resizes on request); the
 * api.nasa.gov endpoint, which can lag behind the site, is the fallback.
 * Days whose entry is a video have no picture.
 */

const FEED = 'https://science.nasa.gov/feed/apod-basic/';
const API = 'https://api.nasa.gov/planetary/apod';
/** Wide enough for a 5px pixel mesh across a large screen, small enough to fetch once a day. */
const WIDTH = 960;
const TIMEOUT_MS = 15_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
	return text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
		.replace(/\s+/g, ' ')
		.trim();
}

function tag(item: string, name: string): string | null {
	const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
	return match ? match[1] : null;
}

/** NASA's image service resizes by query; ask for a web-sized copy instead of the full-resolution original. */
export function sized(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== 'assets.science.nasa.gov' || !parsed.pathname.startsWith('/dynamicimage/')) return url;
		parsed.search = '';
		parsed.searchParams.set('w', String(WIDTH));
		parsed.searchParams.set('fit', 'clip');
		return parsed.toString();
	} catch {
		return url;
	}
}

/** The newest entry of the APOD feed, or null when it has no picture. */
export function fromFeed(xml: string): DailyPictureInfo | null {
	const item = tag(xml, 'item');
	if (!item) return null;
	const image = decode(tag(item, 'apod:hdurl') ?? '');
	const title = decode(tag(item, 'title') ?? '');
	const published = new Date(decode(tag(item, 'pubDate') ?? ''));
	if (!image || !title || Number.isNaN(published.getTime()) || !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(image)) return null;
	const credit = decode(tag(item, 'apod:credit') ?? tag(item, 'apod:copyright') ?? '');
	return {
		date: published.toISOString().slice(0, 10),
		title,
		credit: credit ? `${credit}, via NASA APOD` : 'NASA APOD',
		link: decode(tag(item, 'link') ?? '') || 'https://science.nasa.gov/apod/',
		imageUrl: sized(image),
	};
}

type ApiEntry = { date?: string; title?: string; copyright?: string; media_type?: string; url?: string; hdurl?: string; thumbnail_url?: string };

/** An api.nasa.gov entry, unless it is a video or the service sent its placeholder (NASA's logo) instead of the picture. */
export function fromApi(entry: ApiEntry): DailyPictureInfo | null {
	const image = entry.media_type === 'image' ? entry.url : entry.thumbnail_url;
	if (!image || !entry.date || !entry.title || /nasa-logo/i.test(image)) return null;
	const date = entry.date;
	const [year, month, day] = date.split('-');
	return {
		date,
		title: entry.title.trim(),
		credit: entry.copyright ? `${entry.copyright.replace(/\s+/g, ' ').trim()}, via NASA APOD` : 'NASA APOD',
		link: `https://apod.nasa.gov/apod/ap${year.slice(2)}${month}${day}.html`,
		imageUrl: image,
	};
}

async function get(url: string, signal?: AbortSignal): Promise<Response> {
	const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'Anton (self-hosted coding agent)' } });
	if (!response.ok) throw new Error(`${new URL(url).hostname} answered ${response.status}`);
	return response;
}

export function nasaApod({ apiKey }: { apiKey: string }): DailyPicture {
	return {
		async today(signal) {
			try {
				const found = fromFeed(await (await get(FEED, signal)).text());
				if (found) return found;
			} catch (error) {
				if (signal?.aborted) throw error;
			}
			const entry = (await (await get(`${API}?api_key=${encodeURIComponent(apiKey)}&thumbs=true`, signal)).json()) as ApiEntry;
			return fromApi(entry);
		},
		async image(url, signal) {
			const response = await get(url, signal);
			const type = response.headers.get('content-type')?.split(';')[0].trim() ?? 'image/jpeg';
			if (!type.startsWith('image/') || type === 'image/svg+xml') throw new Error(`Not a picture: ${type}`);
			return { bytes: new Uint8Array(await response.arrayBuffer()), type };
		},
	};
}
