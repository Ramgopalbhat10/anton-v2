import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

/**
 * Draws the app's icons (favicon, home screen, splash, notification badge)
 * from Anton's mark, the prompt-faced machine in `Logo` (illustrations.tsx).
 * Run after changing the mark: `node scripts/make-icons.ts`. Needs Chromium
 * (`ANTON_CHROMIUM` or Playwright's own).
 */

const OUT = new URL('../src/web/public/icons/', import.meta.url);
const CYAN = '#3FB6D8';
const TILE = '#101517';
const VIEW = 'viewBox="2.5 1 19 20.5"';
/** The mark in `fill`, its prompt cut out so whatever is behind shows through. */
const mark = (fill: string) =>
	'<mask id="m"><rect width="24" height="24" fill="#fff"/><path d="M7.3 11.3 10.4 14 7.3 16.7M12.9 16.7h3.6" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></mask>' +
	`<g fill="${fill}"><path mask="url(#m)" d="M7.4 7h9.2a4.4 4.4 0 0 1 4.4 4.4v5.2a4.4 4.4 0 0 1-4.4 4.4H7.4A4.4 4.4 0 0 1 3 16.6v-5.2A4.4 4.4 0 0 1 7.4 7Z"/><rect x="15.35" y="3.4" width="1.5" height="4"/><circle cx="16.1" cy="3.1" r="1.75"/></g>`;
/** The mark centred at `scale` of a 24-unit square. */
const centred = (scale: number, fill = CYAN) => `<g transform="translate(12 12) scale(${scale}) translate(-12 -11.25)">${mark(fill)}</g>`;

/** The bare mark, as the sidebar shows it: the favicon, legible on light and dark tabs alike. */
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" ${VIEW}>${mark(CYAN)}</svg>`;
/** On a dark rounded tile with a hairline edge: the plain app icon. */
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="${TILE}"/><rect x=".25" y=".25" width="23.5" height="23.5" rx="5.25" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width=".5"/>${centred(0.72)}</svg>`;
/** Edge to edge, the mark well inside the middle 80%, for launchers that cut their own shape (maskable) and for iOS, which rounds the corners itself. */
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${TILE}"/>${centred(0.6)}</svg>`;
/** One colour on clear, as Android's status bar draws a notification's badge. */
const badge = `<svg xmlns="http://www.w3.org/2000/svg" ${VIEW}>${mark('#fff')}</svg>`;

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
