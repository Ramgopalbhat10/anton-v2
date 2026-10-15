/*
 * An HTML file in a Library is often one of several: index.html beside its
 * styles.css, app.js and images. A page is served with no network (see
 * renders.ts), so those files never load and the page shows unstyled and
 * dead. Before it is served, each file the page names by a path in its own
 * Library is put into the page itself: stylesheets as <style>, scripts as
 * inline <script>, and images and fonts (in the page or its stylesheets) as
 * data: URLs. Anything outside the Library, or on the web, stays as it was and
 * is still blocked.
 */

type Read = (path: string) => Promise<Uint8Array | null>;

/** The most of a page's own files put into it, together and each. */
export const MAX_INLINED_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 3 * 1024 * 1024;

const TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
	avif: 'image/avif',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	mp4: 'video/mp4',
	webm: 'video/webm',
};

/**
 * The Library path a reference in a file at `from` names, or null when it
 * names nothing there (the web, an anchor, a data: URL, or outside the
 * Library). A path from the site's root, as a built app writes /assets/app.js,
 * is read from the page's own folder, where its build put it.
 */
export function resolveAsset(from: string, ref: string, root = from): string | null {
	const trimmed = ref.trim();
	const href = trimmed.replace(/[?#].*$/, '');
	if (!href || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmed)) return null;
	const parts = (href.startsWith('/') ? root : from).split('/').slice(0, -1);
	for (const part of href.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(decodeURIComponentSafe(part));
	}
	return parts.length ? parts.join('/') : null;
}

function decodeURIComponentSafe(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
const valueOf = (match: RegExpExecArray | null) => (match ? (match[1] ?? match[2] ?? match[3] ?? '') : null);

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

/** Puts the files a page names from its own Library into the page, so it works with no network. */
export async function inlineAssets(html: string, path: string, read: Read): Promise<string> {
	let budget = MAX_INLINED_BYTES;
	const cache = new Map<string, Promise<Uint8Array | null>>();
	const load = async (file: string): Promise<Uint8Array | null> => {
		if (!cache.has(file)) cache.set(file, read(file).catch(() => null));
		const bytes = await cache.get(file)!;
		if (!bytes || bytes.length > MAX_FILE_BYTES || bytes.length > budget) return null;
		budget -= bytes.length;
		return bytes;
	};
	const dataUrl = async (from: string, ref: string): Promise<string | null> => {
		const file = resolveAsset(from, ref, path);
		const type = file ? TYPES[file.split('.').pop()?.toLowerCase() ?? ''] : undefined;
		if (!file || !type) return null;
		const bytes = await load(file);
		return bytes ? `data:${type};base64,${toBase64(bytes)}` : null;
	};
	const css = async (text: string, from: string): Promise<string> =>
		replaceAsync(text, /url\(\s*(["']?)([^"')]+)\1\s*\)/gi, async (whole, _quote, ref: string) => {
			const url = await dataUrl(from, ref);
			return url ? `url("${url}")` : whole;
		});
	const text = new TextDecoder();

	// Stylesheets the page links: their own images and fonts go in too.
	let out = await replaceAsync(html, /<link\b[^>]*>/gi, async (tag) => {
		const rel = valueOf(attr(tag, 'rel'))?.toLowerCase() ?? '';
		const href = valueOf(attr(tag, 'href'));
		if (!href) return tag;
		if (/\bstylesheet\b/.test(rel)) {
			const file = resolveAsset(path, href);
			const bytes = file ? await load(file) : null;
			if (!file || !bytes) return tag;
			const media = valueOf(attr(tag, 'media'));
			return `<style${media ? ` media="${media.replace(/"/g, '&quot;')}"` : ''}>${(await css(text.decode(bytes), file)).replace(/<\/style/gi, '<\\/style')}</style>`;
		}
		if (/\bicon\b/.test(rel)) {
			const url = await dataUrl(path, href);
			return url ? tag.replace(href, url) : tag;
		}
		return tag;
	});
	// Scripts it loads by src, in place and in order, with their other attributes (type="module", defer).
	out = await replaceAsync(out, /<script\b([^>]*)>\s*<\/script\s*>/gi, async (tag, attributes: string) => {
		const src = valueOf(attr(` ${attributes}`, 'src'));
		const file = src ? resolveAsset(path, src) : null;
		const bytes = file ? await load(file) : null;
		if (!bytes) return tag;
		const rest = ` ${attributes}`
			.replace(/\s(src|integrity|crossorigin)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, '')
			// An inline script runs at once; defer and async mean nothing to it.
			.replace(/\s(defer|async)(?=[\s>]|$)/gi, '')
			.trim();
		return `<script${rest ? ` ${rest}` : ''}>${text.decode(bytes).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')}</script>`;
	});
	// Images, and the media and posters the page names.
	out = await replaceAsync(out, /<(img|source|video|audio|input)\b[^>]*>/gi, async (tag) => {
		let next = tag;
		for (const name of ['src', 'poster']) {
			const ref = valueOf(attr(next, name));
			const url = ref ? await dataUrl(path, ref) : null;
			if (ref && url) next = next.replace(attr(next, name)![0], ` ${name}="${url}"`);
		}
		return next;
	});
	// Styles written in the page, and on its elements.
	out = await replaceAsync(out, /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, async (_whole, open: string, body: string, close: string) => `${open}${await css(body, path)}${close}`);
	return out;
}

async function replaceAsync(text: string, pattern: RegExp, replace: (...match: string[]) => Promise<string>): Promise<string> {
	const parts: Array<string | Promise<string>> = [];
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		parts.push(text.slice(last, match.index));
		parts.push(replace(...(match as unknown as string[])));
		last = match.index! + match[0].length;
	}
	parts.push(text.slice(last));
	return (await Promise.all(parts)).join('');
}
