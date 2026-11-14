import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

/**
 * Draws the app's icons (favicon, home screen, splash, notification badge)
 * from Anton's mark, the ring on an accent tile in `Logo` (illustrations.tsx),
 * and stamps their links with a hash of the mark (`?v=`), since browsers keep a
 * favicon by its address long after the file changes. Run after changing the mark: `node scripts/make-icons.ts`. Needs Chromium
 * (`ANTON_CHROMIUM` or Playwright's own).
 */

const OUT = new URL('../src/web/public/icons/', import.meta.url);
const ACCENT = '#6E72F7';
/** The ring and its centre, in `ink`, on a 24-unit square. */
const ring = (ink: string) => `<circle cx="12" cy="12" r="5.2" fill="none" stroke="${ink}" stroke-width="2"/><circle cx="12" cy="12" r="1.8" fill="${ink}"/>`;

/** The mark as the sidebar shows it, a rounded tile: the favicon, legible on light and dark tabs alike. */
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="${ACCENT}"/>${ring('#fff')}</svg>`;
/** The same tile, edge to edge with its own corners: the plain app icon. */
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="${ACCENT}"/>${ring('#fff')}</svg>`;
/** Edge to edge, the ring well inside the middle 80%, for launchers that cut their own shape (maskable) and for iOS, which rounds the corners itself. */
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${ACCENT}"/><g transform="translate(12 12) scale(0.86) translate(-12 -12)">${ring('#fff')}</g></svg>`;
/** One colour on clear, as Android's status bar draws a notification's badge. */
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3 3 18 18">${ring('#fff')}</svg>`;

const pngs: Array<{ name: string; svg: string; size: number }> = [
	{ name: 'icon-192.png', svg: tile, size: 192 },
	{ name: 'icon-512.png', svg: tile, size: 512 },
	{ name: 'maskable-512.png', svg: fullBleed, size: 512 },
	{ name: 'apple-touch-icon.png', svg: fullBleed, size: 180 },
	{ name: 'badge-96.png', svg: badge, size: 96 },
];

await mkdir(OUT, { recursive: true });
await writeFile(new URL('icon.svg', OUT), `${favicon}\n`);
const browser = await chromium.launch({ executablePath: process.env.ANTON_CHROMIUM || undefined });
try {
	for (const { name, svg, size } of pngs) {
		const page = await browser.newPage({ viewport: { width: size, height: size } });
		await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
		await writeFile(new URL(name, OUT), await page.screenshot({ omitBackground: true }));
		await page.close();
	}
} finally {
	await browser.close();
}

/** Every link to an icon, in the page, the manifest and the service worker, names this mark's version. */
const version = createHash('sha256').update(favicon + tile + fullBleed + badge).digest('hex').slice(0, 8);
for (const file of ['../src/web/index.html', '../src/web/public/manifest.webmanifest', '../src/web/public/sw.js']) {
	const url = new URL(file, import.meta.url);
	const text = await readFile(url, 'utf8');
	await writeFile(url, text.replace(/(\/icons\/[\w-]+\.(?:svg|png))(?:\?v=\w+)?/g, `$1?v=${version}`));
}
