import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

/**
 * Draws the app's icons (favicon, home screen, splash, notification badge)
 * from Anton's mark, the A-cut cube in `Logo` (illustrations.tsx).
 * Run after changing the mark: `node scripts/make-icons.ts`. Needs Chromium
 * (`ANTON_CHROMIUM` or Playwright's own).
 */

const OUT = new URL('../src/web/public/icons/', import.meta.url);
const FACES = ['M12 3.4 19.45 7.7 12 12 4.55 7.7Z', 'M4.55 7.7 12 12 9.32 19.05 4.55 16.3Z', 'M12 12 19.45 7.7 19.45 16.3 14.68 19.05Z'];
const mark = (fills: string[]) => FACES.map((d, i) => `<path d="${d}" fill="${fills[i]}"/>`).join('');
const CYAN = mark(['#9EE1F3', '#2C9BBD', '#17627A']);
const TILE = '#111214';

/** The bare mark, as the sidebar shows it: the favicon, legible on light and dark tabs alike. */
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2.5 2.5 19 19">${CYAN}</svg>`;
/** On a dark rounded tile with a hairline edge: the plain app icon. */
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="${TILE}"/><rect x=".25" y=".25" width="23.5" height="23.5" rx="5.25" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width=".5"/><g transform="translate(12 12) scale(0.82) translate(-12 -12)">${CYAN}</g></svg>`;
/** Edge to edge, the mark well inside the middle 80%, for launchers that cut their own shape (maskable) and for iOS, which rounds the corners itself. */
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${TILE}"/><g transform="translate(12 12) scale(0.66) translate(-12 -12)">${CYAN}</g></svg>`;
/** One colour on clear, as Android's status bar draws a notification's badge: the faces told apart by alpha. */
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2.5 2.5 19 19">${mark(['#fff', 'rgba(255,255,255,.72)', 'rgba(255,255,255,.45)'])}</svg>`;

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
