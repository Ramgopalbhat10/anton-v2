import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

/**
 * Draws the app's icons (favicon, home screen, splash, notification badge)
 * from Anton's mark, the folded-ribbon A in `Logo` (illustrations.tsx).
 * Run after changing the mark: `node scripts/make-icons.ts`. Needs Chromium
 * (`ANTON_CHROMIUM` or Playwright's own).
 */

const OUT = new URL('../src/web/public/icons/', import.meta.url);
const SHAPES = {
	bar: 'M8.95 13.2H15.05L16.04 15.6H7.96Z',
	right: 'M17 20.8H21.6L14.3 3.2H9.7Z',
	left: 'M2.4 20.8H7L14.3 3.2H9.7Z',
	crease: 'M9.7 3.2H14.3L12 7.57Z',
};
const GRADIENTS =
	'<linearGradient id="l" x1="0" y1="1" x2="0.6" y2="0"><stop offset="0" stop-color="#2394BC"/><stop offset="1" stop-color="#7FDDF5"/></linearGradient>' +
	'<linearGradient id="r" x1="1" y1="1" x2="0.4" y2="0"><stop offset="0" stop-color="#0F5674"/><stop offset="1" stop-color="#2C9BBD"/></linearGradient>' +
	'<linearGradient id="x" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1E7FA3"/><stop offset="1" stop-color="#145F7E"/></linearGradient>';
const mark = (fill: Record<keyof typeof SHAPES, string>) =>
	(Object.keys(SHAPES) as Array<keyof typeof SHAPES>).map((key) => `<path d="${SHAPES[key]}" fill="${fill[key]}"/>`).join('');
const CYAN = mark({ bar: 'url(#x)', right: 'url(#r)', left: 'url(#l)', crease: '#D4F7FF' });
const TILE = '#111214';
const VIEW = 'viewBox="2 2.6 20 18.8"';

/** The bare mark, as the sidebar shows it: the favicon, legible on light and dark tabs alike. */
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" ${VIEW}><defs>${GRADIENTS}</defs>${CYAN}</svg>`;
/** On a dark rounded tile with a hairline edge: the plain app icon. */
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs>${GRADIENTS}</defs><rect width="24" height="24" rx="5.5" fill="${TILE}"/><rect x=".25" y=".25" width="23.5" height="23.5" rx="5.25" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width=".5"/><g transform="translate(12 12) scale(0.72) translate(-12 -12)">${CYAN}</g></svg>`;
/** Edge to edge, the mark well inside the middle 80%, for launchers that cut their own shape (maskable) and for iOS, which rounds the corners itself. */
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs>${GRADIENTS}</defs><rect width="24" height="24" fill="${TILE}"/><g transform="translate(12 12) scale(0.6) translate(-12 -12)">${CYAN}</g></svg>`;
/** One colour on clear, as Android's status bar draws a notification's badge: the pieces told apart by alpha. */
const badge = `<svg xmlns="http://www.w3.org/2000/svg" ${VIEW}>${mark({ bar: 'rgba(255,255,255,.45)', right: 'rgba(255,255,255,.7)', left: '#fff', crease: '#fff' })}</svg>`;

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
