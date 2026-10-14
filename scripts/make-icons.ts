import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

/**
 * Draws the app's icons (home screen, splash, notification badge) from
 * Anton's mark, the cube on a cyan tile in `Logo` (illustrations.tsx).
 * Run after changing the mark: `node scripts/make-icons.ts`. Needs Chromium
 * (`ANTON_CHROMIUM` or Playwright's own).
 */

const OUT = new URL('../src/web/public/icons/', import.meta.url);
const CUBE = '<path d="M10 4.6 15 7.4V12.6L10 15.4 5 12.6V7.4Z"/><path d="M5 7.4 10 10.2 15 7.4M10 10.2V15.4"/>';
const GRADIENT = '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6FCDE8"/><stop offset="1" stop-color="#1F7F9E"/></linearGradient>';

/** The mark on its rounded tile, as the sidebar shows it: the favicon and the plain app icon. */
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><defs>${GRADIENT}</defs><rect width="20" height="20" rx="5.5" fill="url(#g)"/><g fill="none" stroke="#06181F" stroke-width="1.3" stroke-linejoin="round">${CUBE}</g></svg>`;
/** Edge to edge, the cube well inside the middle 80%, for launchers that cut their own shape (maskable) and for iOS, which rounds the corners itself. */
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><defs>${GRADIENT}</defs><rect width="20" height="20" fill="url(#g)"/><g transform="translate(10 10) scale(0.78) translate(-10 -10)" fill="none" stroke="#06181F" stroke-width="1.3" stroke-linejoin="round">${CUBE}</g></svg>`;
/** One colour on clear, as Android's status bar draws a notification's badge. */
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><g transform="translate(10 10) scale(1.45) translate(-10 -10)" fill="none" stroke="#fff" stroke-width="1.2" stroke-linejoin="round">${CUBE}</g></svg>`;

const pngs: Array<{ name: string; svg: string; size: number }> = [
	{ name: 'icon-192.png', svg: tile, size: 192 },
	{ name: 'icon-512.png', svg: tile, size: 512 },
	{ name: 'maskable-512.png', svg: fullBleed, size: 512 },
	{ name: 'apple-touch-icon.png', svg: fullBleed, size: 180 },
	{ name: 'badge-96.png', svg: badge, size: 96 },
];

await mkdir(OUT, { recursive: true });
await writeFile(new URL('icon.svg', OUT), `${tile}\n`);
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
