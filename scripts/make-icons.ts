import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

/**
 * Draws the app's icons (favicon, home screen, splash, notification badge)
 * from Anton's mark, the 5×5 pixel A in `Logo` (illustrations.tsx), and
 * stamps their links with a hash of the mark (`?v=`), since browsers keep a
 * favicon by its address long after the file changes. Run after changing the mark: `node scripts/make-icons.ts`. Needs Chromium
 * (`ANTON_CHROMIUM` or Playwright's own).
 */

const OUT = new URL('../src/web/public/icons/', import.meta.url);
const TILE = '#0b0c0f';
/** The mark's rows, as `Logo` draws them: `#` a pixel, `@` the accent pixel on the crossbar. */
const ROWS = ['.###.', '#...#', '##@##', '#...#', '#...#'];
const INK = '#eef0f4';
const ACCENT = '#7096fb';
/** The mark in a 5-unit square, in its colours or all in `one` colour (the badge). */
const mark = (one?: string) =>
	ROWS.flatMap((row, y) =>
		[...row].map((cell, x) => (cell === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${one ?? (cell === '@' ? ACCENT : INK)}"/>`)),
	).join('');
/** The mark centred at `scale` of a 24-unit square. */
const centred = (scale: number) => `<g transform="translate(12 12) scale(${(scale * 24) / 5 / 1.6}) translate(-2.5 -2.5)" shape-rendering="crispEdges">${mark()}</g>`;

/** The bare mark: the favicon, with a dark plate so it reads on light and dark tabs alike. */
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 7 7" shape-rendering="crispEdges"><rect x="-1" y="-1" width="7" height="7" rx="1.4" fill="${TILE}"/>${mark()}</svg>`;
/** On a dark rounded tile with a hairline edge: the plain app icon. */
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="${TILE}"/><rect x=".25" y=".25" width="23.5" height="23.5" rx="5.25" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width=".5"/>${centred(0.88)}</svg>`;
/** Edge to edge, the mark well inside the middle 80%, for launchers that cut their own shape (maskable) and for iOS, which rounds the corners itself. */
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${TILE}"/>${centred(0.72)}</svg>`;
/** One colour on clear, as Android's status bar draws a notification's badge. */
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.5 -0.5 6 6" shape-rendering="crispEdges">${mark('#fff')}</svg>`;

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
